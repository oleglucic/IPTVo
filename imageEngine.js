const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadLogoBuffer, saveLogoBuffer, hasRedis } = require('./redisCache');

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// Task #42: logos that failed to fetch must be re-attempted more frequently
// until obtained (they rarely change once they exist), instead of growing a
// dead-URL entry that permanently shadows retries. Base is now minutes so a
// transient blip recovers quickly; the exponential cap still prevents a truly
// dead URL from being hammered more than ~once/hour.
const DEAD_URL_TTL_BASE = 2 * 60 * 1000;    // 2 min
const DEAD_URL_TTL_MAX = 60 * 60 * 1000;    // 60 min
const MAX_CACHE_FILES = 5000; // soft cap on disk cache to avoid unbounded growth
const FETCH_TIMEOUT = 10000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB - reject absurd payloads before sharp touches them
const LOGO_CACHE_TTL = 30 * 60 * 1000; // 30 minutes - cache fetched logos in memory
const LOGO_CACHE_MAX_SIZE = 2000; // max entries in logo cache

// Square poster output. The poster is the channel's own logo on a themed
// backdrop, and both Stremio and Nuvio render square posters. A square canvas
// (vs. the previous 600x900 vertical) roughly halves pixel count, which cuts
// storage and bandwidth for the cached output without any client change.
const POSTER_SIZE = 640; // 640x640 (1:1)

const deadUrlCache = new Map(); // logoUrl -> {timestamp: number, failCount: number}
const inFlight = new Map();     // cId -> Promise, de-dupes concurrent requests for the same poster
const logoCache = new Map();    // url -> {buffer: Buffer, timestamp: number}

// Cloudflare Worker proxy URL - set via environment variable. Defaults to the
// assets worker (/logo) on assets.oleglucic.com when ASSET_BASE_URL is set.
const ASSET_BASE_URL = process.env.ASSET_BASE_URL || '';
const LOGO_PROXY_URL = process.env.LOGO_PROXY_URL || (ASSET_BASE_URL ? ASSET_BASE_URL.replace(/\/$/, '') + '/logo' : 'https://logo-proxy.your-worker.workers.dev/logo');

function isSvgBuffer(buffer) {
    if (!buffer || buffer.length === 0) return false;
    const header = buffer.subarray(0, Math.min(50, buffer.length)).toString().trim().toLowerCase();
    return header.startsWith('<svg') || (header.startsWith('<?xml') && header.includes('<svg'));
}

function isDeadUrl(url) {
    const entry = deadUrlCache.get(url);
    if (!entry) return false;
    const now = Date.now();
    const ttl = DEAD_URL_TTL_BASE * Math.pow(2, Math.min(entry.failCount, 4)); // exponential up to 2^4=16x base
    if (now - entry.timestamp > Math.min(ttl, DEAD_URL_TTL_MAX)) {
        deadUrlCache.delete(url);
        return false;
    }
    return true;
}

function markDeadUrl(url, success = false) {
    const entry = deadUrlCache.get(url) || {timestamp: Date.now(), failCount: 0};
    if (success) {
        deadUrlCache.delete(url);
    } else {
        entry.failCount += 1;
        entry.timestamp = Date.now();
        deadUrlCache.set(url, entry);
    }
}

function getFromLogoCache(url) {
    const entry = logoCache.get(url);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.timestamp > LOGO_CACHE_TTL) {
        logoCache.delete(url);
        return null;
    }
    return entry.buffer;
}

function setLogoCache(url, buffer) {
    // Simple LRU: if exceeds max size, remove oldest entry
    if (logoCache.size >= LOGO_CACHE_MAX_SIZE) {
        // Find oldest timestamp
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, val] of logoCache.entries()) {
            if (val.timestamp < oldestTime) {
                oldestTime = val.timestamp;
                oldestKey = key;
            }
        }
        if (oldestKey !== null) {
            logoCache.delete(oldestKey);
        }
    }
    logoCache.set(url, {buffer, timestamp: Date.now()});
}

function base64urlEncode(str) {
    return Buffer.from(str).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/**
 * Fetch logo via Cloudflare Worker proxy with fallback chain.
 * Worker handles: rate limiting, retries, 403/404 fallback, dead URL tracking (KV).
 * Returns: { buffer: Buffer, contentType: string, source: string }
 */
async function fetchLogoViaProxy(primaryUrl, fallbackUrl, channelName) {
    const primaryB64 = base64urlEncode(primaryUrl);
    const params = new URLSearchParams({ url: primaryB64 });
    if (fallbackUrl) params.append('fallback', base64urlEncode(fallbackUrl));
    if (channelName) params.append('name', channelName);

    const proxyUrl = `${LOGO_PROXY_URL}?${params.toString()}`;

    const response = await axios.get(proxyUrl, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT,
        maxContentLength: MAX_IMAGE_BYTES,
        validateStatus: s => s === 200, // Worker always returns 200 (with placeholder on failure)
    });

    const source = response.headers['x-logo-source'] || 'unknown';
    const contentType = response.headers['content-type'] || 'image/svg+xml';

    return {
        buffer: Buffer.from(response.data),
        contentType,
        source
    };
}

/**
 * Fetch logo directly (fallback if Worker proxy unavailable).
 * Used as last resort when env var not configured.
 */
async function fetchLogoDirect(logoUrl) {
    if (!logoUrl || !logoUrl.startsWith('http')) throw new Error("Invalid or missing logo URL");

    const response = await axios.get(logoUrl, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT,
        maxContentLength: MAX_IMAGE_BYTES,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IPTVo/1.0)' },
        validateStatus: s => s === 200,
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
        throw new Error(`Non-image content-type: ${contentType}`);
    }

    return { buffer: Buffer.from(response.data), contentType };
}

/**
 * Generates a promotional poster using a cached or fetched channel logo, falling back to a generated poster when necessary.
 * @param {string} cId - The channel identifier used for diagnostic logging.
 * @param {string} logoUrl - The primary logo URL.
 * @param {string} fallbackUrl - An optional fallback logo URL.
 * @param {string} fallbackName - The channel name displayed on the fallback poster.
 * @param {string} cachePath - The path where the generated poster is saved.
 * @return {Promise<string>} The path to the generated poster.
 */
async function renderPoster(cId, logoUrl, fallbackUrl, fallbackName, cachePath) {
    const sourceLog = [];

    // Handle missing/null logo URL early
    if (!logoUrl || typeof logoUrl !== 'string' || !logoUrl.startsWith('http')) {
        return await generateFallback(cachePath, fallbackName, ['no-logo']);
    }

    // 1. Check in-memory logo cache (fastest ~1ms)
    const cachedBuffer = getFromLogoCache(logoUrl);
    if (cachedBuffer) {
        sourceLog.push('memory');
        try {
            return await generatePosterFromBuffer(cachedBuffer, cachePath, sourceLog);
        } catch (sharpErr) {
            console.error(`[imageEngine] Sharp processing failed for cId=${cId} (cached logo): ${sharpErr.message}`);
        }
    }

    // 2. Check Redis logo cache (survives restarts, ~5-10ms)
    if (hasRedis) {
        const redisBuffer = await loadLogoBuffer(logoUrl);
        if (redisBuffer) {
            // Skip SVG placeholders that may have been cached - Sharp can't process them for background blur
            if (isSvgBuffer(redisBuffer)) {
                console.log(`[imageEngine] Skipping SVG placeholder in Redis for ${cId}`);
            } else {
                sourceLog.push('redis');
                setLogoCache(logoUrl, redisBuffer); // promote to memory cache
                try {
                    return await generatePosterFromBuffer(redisBuffer, cachePath, sourceLog);
                } catch (sharpErr) {
                    console.error(`[imageEngine] Sharp processing failed for cId=${cId} (Redis logo): ${sharpErr.message}`);
                }
            }
        }
    }

    // 3. Check dead URL cache
    if (isDeadUrl(logoUrl)) {
        sourceLog.push('dead-cache');
        return await generateFallback(cachePath, fallbackName, sourceLog);
    }

    // 4. Fetch via Cloudflare Worker proxy (handles rate limits, fallbacks, caching)
    try {
        const { buffer, contentType, source } = await fetchLogoViaProxy(logoUrl, fallbackUrl, fallbackName);
        sourceLog.push(`worker:${source}`);

        if (source === 'placeholder') {
            // Worker returned placeholder - generate locally for consistency
            return await generateFallback(cachePath, fallbackName, sourceLog);
        }

        // Valid image - cache it
        setLogoCache(logoUrl, buffer);
        if (hasRedis) {
            await saveLogoBuffer(logoUrl, buffer);
        }
        markDeadUrl(logoUrl, true); // success

        return await generatePosterFromBuffer(buffer, cachePath, sourceLog, contentType);

    } catch (err) {
        console.error(`[imageEngine] Worker proxy fetch failed for cId=${cId}, logoUrl=${logoUrl}: ${err.message}`);
        sourceLog.push('worker:error');
    }

    // 5. Final fallback: direct fetch (if Worker proxy not configured)
    if (LOGO_PROXY_URL === 'https://logo-proxy.your-worker.workers.dev/logo') {
        try {
            const { buffer, contentType } = await fetchLogoDirect(logoUrl);
            sourceLog.push('direct');
            setLogoCache(logoUrl, buffer);
            if (hasRedis) {
                await saveLogoBuffer(logoUrl, buffer);
            }
            markDeadUrl(logoUrl, true);
            return await generatePosterFromBuffer(buffer, cachePath, sourceLog, contentType);
        } catch (directErr) {
            console.error(`[imageEngine] Direct fetch also failed for ${logoUrl}: ${directErr.message}`);
            sourceLog.push('direct:error');
        }
    }

    // 6. Ultimate fallback: generated SVG
    markDeadUrl(logoUrl, false);
    return await generateFallback(cachePath, fallbackName, sourceLog);
}

/**
 * Generates a promotional poster from a logo image and saves it to the cache.
 * @param {Buffer} logoBuffer - The source logo image data.
 * @param {string} cachePath - The destination path for the generated poster.
 * @param {string[]} sourceLog - The log of image sources used during generation.
 * @return {string} The path of the generated poster.
 */
async function generatePosterFromBuffer(logoBuffer, cachePath, sourceLog, _contentType = 'image/png') {
    // If we got an SVG, we can use it directly for high-quality scaling
    let processBuffer = logoBuffer;
    let isSvg = isSvgBuffer(logoBuffer);

    if (isSvg) {
        // For SVG source, we still render via Sharp but it handles SVG→PNG natively
        sourceLog.push('svg-source');
    }

    const background = await sharp(processBuffer)
        .resize(POSTER_SIZE, POSTER_SIZE, { fit: 'cover' })
        .blur(35)
        .linear(0.55, 0)
        .toBuffer();

    const haloSvg = `
        <svg width="${POSTER_SIZE}" height="${POSTER_SIZE}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <radialGradient id="haloGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35" />
                    <stop offset="60%" stop-color="#ffffff" stop-opacity="0.15" />
                    <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0" />
                </radialGradient>
            </defs>
            <rect width="${POSTER_SIZE}" height="${POSTER_SIZE}" fill="url(#haloGlow)" />
        </svg>
    `;
    const haloBuffer = Buffer.from(haloSvg);

    // Inset by ~20% so the logo reads as a rounded badge on the square backdrop
    const fgSize = Math.round(POSTER_SIZE * 0.72);
    const foreground = await sharp(processBuffer)
        .resize(fgSize, fgSize, { fit: 'inside' })
        .toBuffer();

    await sharp(background)
        .composite([
            { input: haloBuffer, gravity: 'center' },
            { input: foreground, gravity: 'center' }
        ])
        .toFile(cachePath);

    console.log(`[imageEngine] Poster generated for ${cachePath} (sources: ${sourceLog.join(' → ')})`);
    return cachePath;
}

async function generateFallback(cachePath, fallbackName, sourceLog = []) {
    sourceLog.push('fallback-svg');
    const text = fallbackName || 'Live TV';
    const svg = `
        <svg width="${POSTER_SIZE}" height="${POSTER_SIZE}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#0f172a" />
                    <stop offset="100%" stop-color="#1e293b" />
                </linearGradient>
            </defs>
            <rect width="${POSTER_SIZE}" height="${POSTER_SIZE}" fill="url(#bgGrad)" />
            <text x="${POSTER_SIZE / 2}" y="${POSTER_SIZE / 2}" text-anchor="middle" dominant-baseline="middle"
                  font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(POSTER_SIZE * 0.07)}" font-weight="600" fill="#94a3b8">
                ${text}
            </text>
        </svg>
    `;
    await sharp(Buffer.from(svg))
        .resize(POSTER_SIZE, POSTER_SIZE, { fit: 'fill' })
        .toFile(cachePath);

    console.log(`[imageEngine] Fallback poster generated for ${cachePath} (sources: ${sourceLog.join(' → ')})`);
    return cachePath;
}

function evictOldestIfOverCap() {
    try {
        const files = fs.readdirSync(cacheDir);
        if (files.length <= MAX_CACHE_FILES) return;

        const withStats = files.map(f => {
            const full = path.join(cacheDir, f);
            return { full, mtime: fs.statSync(full).mtimeMs };
        }).sort((a, b) => a.mtime - b.mtime);

        const toRemove = withStats.slice(0, files.length - MAX_CACHE_FILES);
        for (const f of toRemove) fs.unlinkSync(f.full);
        if (toRemove.length > 0) {
            console.log(`[imageEngine] Evicted ${toRemove.length} oldest cached posters (cap=${MAX_CACHE_FILES})`);
        }
    } catch (e) {
        console.error('[imageEngine] Cache eviction check failed:', e.message);
    }
}

/**
 * Retrieves or generates a cached promotional poster for a channel.
 * @param {string} cId - The channel identifier.
 * @param {string} [logoUrl] - The primary logo URL.
 * @param {string} [fallbackName] - The channel name used for fallback poster generation.
 * @returns {string} The path to the cached poster.
 * @throws {Error} If the channel identifier is invalid or the cache path is unsafe.
 */
async function getPremiumPoster(cId, logoUrl, fallbackName) {
    // Support fallback URL as optional 4th parameter (for parser to pass playlist logo)
    // For backward compatibility with server.js call, we check if logoUrl is an object
    let primaryUrl = logoUrl;
    let fallbackUrl = null;
    let channelName = fallbackName;

    // Handle extended signature: getPremiumPoster(cId, primaryUrl, fallbackUrl, channelName)
    // This is used by parser when it has both iptv-org and playlist logos
    if (arguments.length >= 4) {
        fallbackUrl = arguments[3]; // fallbackName was 3rd arg in old signature
        channelName = arguments[4] || fallbackName; // channelName is 4th in new, 3rd in old
    }

    // Validate channel ID to prevent path traversal (CodeQL: path injection)
    if (!cId || !/^[a-zA-Z0-9_-]+$/.test(cId)) {
        throw new Error("Invalid channel ID");
    }

    const urlHash = primaryUrl ? crypto.createHash('md5').update(primaryUrl).digest('hex').substring(0, 8) : 'none';
    // Size/resolution stamp in the filename so a poster-cache format change
    // (e.g. 600x900 vertical -> ${POSTER_SIZE} square) regenerates instead of
    // serving a stale-sized file. Old un-suffixed files are left for the cap
    // to evict gradually.
    const sizeTag = `sq${POSTER_SIZE}`;
    const cachePath = path.join(cacheDir, `${cId}_${urlHash}_${sizeTag}.png`);

    // Defense-in-depth: validate resolved path stays within cache directory
    const resolvedPath = path.resolve(cachePath);
    const resolvedCacheDir = path.resolve(cacheDir);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
        throw new Error("Path traversal attempt detected");
    }

    // Serve a cached poster, but NEVER permanently: a fallback SVG can ride on
    // disk and shadow re-fetching a URL that has since recovered. Only return
    // the cached file while the URL is inside its (short, expiring) dead-URL
    // retry window; once that expires the next request re-fetches and the
    // success overwrites it (and clears the dead-URL mark).
    if (fs.existsSync(cachePath) && !isDeadUrl(primaryUrl)) return cachePath;

    const inFlightKey = cachePath;
    if (inFlight.has(inFlightKey)) {
        return inFlight.get(inFlightKey);
    }

    const promise = renderPoster(cId, primaryUrl, fallbackUrl, channelName, cachePath)
        .finally(() => {
            inFlight.delete(inFlightKey);
            evictOldestIfOverCap();
        });

    inFlight.set(inFlightKey, promise);
    return promise;
}

// Task #42 retry pass: the logo refresh loop re-attempts URLs whose last fetch
// FAILED, on the same (short, expiring) retry window. Success clears the mark.
function isLogoMissPending(url) {
    return isDeadUrl(url);
}

module.exports = { getPremiumPoster, isLogoMissPending, markDeadUrl };