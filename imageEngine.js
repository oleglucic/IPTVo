const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
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

// Cloudflare Workers free plan caps request volume (100k/day across all
// Workers). When that quota is exhausted the proxy returns a non-200 error and
// every poster render would otherwise fail to the SVG placeholder. Once a proxy
// failure is observed, stop hitting the worker for a cooldown window and fall
// back to the server's own cache/direct fetch, so posters still render.
const WORKER_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
let workerCooldownUntil = 0;
/**
 * Determines whether the proxy worker is currently within its cooldown period.
 * @return {boolean} `true` if the cooldown period is active, `false` otherwise.
 */
function isWorkerInCooldown() { return Date.now() < workerCooldownUntil; }
/**
 * Starts the cooldown period for the Worker proxy.
 */
function armWorkerCooldown() { workerCooldownUntil = Date.now() + WORKER_COOLDOWN_MS; }

// Cloudflare Worker proxy URL - set via environment variable. Defaults to the
// assets worker (/logo) on assets.oleglucic.com when ASSET_BASE_URL is set.
const ASSET_BASE_URL = process.env.ASSET_BASE_URL || '';
const LOGO_PROXY_URL = process.env.LOGO_PROXY_URL || (ASSET_BASE_URL ? ASSET_BASE_URL.replace(/\/$/, '') + '/logo' : 'https://logo-proxy.your-worker.workers.dev/logo');
// Whether a proxy was actually configured (env or derived from ASSET_BASE_URL),
// as opposed to the placeholder default. Direct fetch is allowed whenever no
// proxy config was provided — never gated on matching the placeholder string.
const PROXY_CONFIGURED = Boolean(process.env.LOGO_PROXY_URL || process.env.ASSET_BASE_URL);

/**
 * Determines whether a buffer begins with SVG markup.
 * @param {Buffer} buffer - The buffer to inspect.
 * @return {boolean} `true` if the buffer contains SVG markup, `false` otherwise.
 */
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
 * Validates that an IP address is publicly routable (not loopback, private, link-local, etc.).
 * @param {string} ip - The IP address to validate.
 * @return {boolean} `true` if the IP is public, `false` otherwise.
 */
function isPublicIP(ip) {
    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        // Loopback: 127.0.0.0/8
        if (parts[0] === 127) return false;
        // Private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
        if (parts[0] === 10) return false;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
        if (parts[0] === 192 && parts[1] === 168) return false;
        // Link-local: 169.254.0.0/16
        if (parts[0] === 169 && parts[1] === 254) return false;
        // Broadcast: 255.255.255.255
        if (parts[0] === 255) return false;
        // 0.0.0.0/8
        if (parts[0] === 0) return false;
        return true;
    } else if (net.isIPv6(ip)) {
        const lower = ip.toLowerCase();
        // Loopback: ::1
        if (lower === '::1') return false;
        // Link-local: fe80::/10
        if (lower.startsWith('fe80:')) return false;
        // ULA: fc00::/7 (fd00::/8 and fc00::/8)
        if (lower.startsWith('fc') || lower.startsWith('fd')) return false;
        // Deprecated site-local: fec0::/10
        if (lower.startsWith('fec0:')) return false;
        return true;
    }
    return false;
}

/**
 * Validates a URL hostname and its resolved IP address to prevent SSRF.
 * @param {string} url - The URL to validate.
 * @throws {Error} If the URL or its resolved IP is not safe for fetching.
 */
async function validateSafeUrl(url) {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Reject localhost variants
    if (hostname === 'localhost' || hostname === '0.0.0.0') {
        throw new Error('Localhost access denied');
    }

    // If hostname is already an IP, validate it directly
    if (net.isIP(hostname)) {
        if (!isPublicIP(hostname)) {
            throw new Error('Private IP access denied');
        }
        return;
    }

    // Resolve hostname and validate all IPs
    try {
        const addresses = await dns.resolve(hostname);
        for (const addr of addresses) {
            if (!isPublicIP(addr)) {
                throw new Error(`Hostname ${hostname} resolves to private IP ${addr}`);
            }
        }
    } catch (err) {
        if (err.message && err.message.includes('private IP')) throw err;
        throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
    }
}

/**
 * Fetch logo directly (fallback if Worker proxy unavailable).
 * Used as last resort when env var not configured.
 * Validates URLs and IPs to prevent SSRF attacks, including redirect targets.
 */
async function fetchLogoDirect(logoUrl) {
    if (!logoUrl || !logoUrl.startsWith('http')) throw new Error("Invalid or missing logo URL");

    // Validate initial URL
    await validateSafeUrl(logoUrl);

    const response = await axios.get(logoUrl, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT,
        maxContentLength: MAX_IMAGE_BYTES,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IPTVo/1.0)' },
        validateStatus: s => s === 200,
        maxRedirects: 5,
        beforeRedirect: async (options) => {
            // Validate redirect target before following
            const redirectUrl = options.href || options.url;
            if (redirectUrl) {
                await validateSafeUrl(redirectUrl);
            }
        }
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
        throw new Error(`Non-image content-type: ${contentType}`);
    }

    return { buffer: Buffer.from(response.data), contentType };
}

/**
 * Generates a channel poster from a cached or fetched logo, preserving an existing poster when logo retrieval fails.
 * @param {string} cId - The channel identifier used for diagnostic logging.
 * @param {string} logoUrl - The primary logo URL.
 * @param {string} fallbackUrl - An optional fallback logo URL.
 * @param {string} fallbackName - The channel name displayed on a generated fallback poster.
 * @param {string} cachePath - The path where the poster is stored.
 * @returns {Promise<string>} The path to the available or generated poster.
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
    //    Skip the worker while it is in cooldown (quota exhausted / repeated
    //    failure) so we don't burn quota or block poster renders on a dead proxy.
    if (PROXY_CONFIGURED && !isWorkerInCooldown()) {
        try {
            const { buffer, contentType, source } = await fetchLogoViaProxy(logoUrl, fallbackUrl, fallbackName);
            sourceLog.push(`worker:${source}`);

            if (source === 'placeholder') {
                // Worker had no real image (dead URL / exhausted fallbacks). Keep
                // the server's existing poster if one exists; only fall through to
                // a direct fetch when we have nothing cached yet.
                sourceLog.push('worker:placeholder');
                if (fs.existsSync(cachePath)) {
                    markDeadUrl(logoUrl, false);
                    return cachePath;
                }
                // Fall through to direct fetch when no cached poster exists
            } else {
                // Valid image - cache it
                setLogoCache(logoUrl, buffer);
                if (hasRedis) {
                    await saveLogoBuffer(logoUrl, buffer);
                }
                markDeadUrl(logoUrl, true); // success

                return await generatePosterFromBuffer(buffer, cachePath, sourceLog, contentType);
            }

        } catch (err) {
            console.error(`[imageEngine] Worker proxy fetch failed for cId=${cId}, logoUrl=${logoUrl}: ${err.message}`);
            sourceLog.push('worker:error');
            // Quota exhaustion returns HTTP 429 (or an edge error page). Either
            // way the next N minutes should skip the worker and use the server's
            // own fetch path below, so posters keep rendering.
            if (err.response && (err.response.status === 429 || err.response.status === 503 || err.response.status === 403)) {
                armWorkerCooldown();
            }
        }
    } else if (PROXY_CONFIGURED) {
        sourceLog.push('worker:cooldown');
    }

    // 5. Direct fetch fallback (Worker proxy unavailable, quota-exhausted, or
    //    not configured). The server's own cache path — and a direct upstream
    //    fetch — keeps posters rendering without the edge proxy.
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
        console.warn(`[imageEngine] Direct fetch failed for ${logoUrl}: ${directErr.message}`);
        sourceLog.push('direct:error');

        // Try fallback URL with the same caching, persistence, and poster flow
        if (fallbackUrl && fallbackUrl !== logoUrl && fallbackUrl.startsWith('http')) {
            try {
                const { buffer, contentType } = await fetchLogoDirect(fallbackUrl);
                sourceLog.push('fallback-direct');
                // Cache under the primary URL key so future requests succeed
                setLogoCache(logoUrl, buffer);
                if (hasRedis) {
                    await saveLogoBuffer(logoUrl, buffer);
                }
                markDeadUrl(logoUrl, true); // primary URL succeeded via fallback
                return await generatePosterFromBuffer(buffer, cachePath, sourceLog, contentType);
            } catch (fallbackErr) {
                console.warn(`[imageEngine] Fallback direct fetch also failed for ${fallbackUrl}: ${fallbackErr.message}`);
                sourceLog.push('fallback-direct:error');
                // Mark primary URL dead since both primary and fallback failed
                markDeadUrl(logoUrl, false);
            }
        } else {
            // No fallback available, mark primary URL dead
            markDeadUrl(logoUrl, false);
        }
    }

    // 6. Ultimate fallback: generated SVG. Only when the server has no cached
    //    poster for this channel yet — never overwrite an existing server-side
    //    poster (a real render from before the outage) with a placeholder.
    if (fs.existsSync(cachePath)) {
        // Direct fetch also failed; mark the URL dead so the next request
        // short-circuits into the dead-URL retry window instead of re-waiting
        // the full FETCH_TIMEOUT for a URL that just failed.
        markDeadUrl(logoUrl, false);
        sourceLog.push('server-cached');
        return cachePath;
    }
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
/**
 * Builds the deterministic on-disk path for a channel poster. Single source of
 * truth for the filename (md5 url-hash + size stamp), shared with the prewarm
 * job so both agree on "already rendered" and never drift if POSTER_SIZE changes.
 * @param {string} cId - The channel identifier (validated by callers).
 * @param {string} [primaryUrl] - The primary logo URL used to derive the url-hash.
 * @return {string} The cache file path on disk.
 */
function posterPath(cId, primaryUrl) {
    const urlHash = primaryUrl ? crypto.createHash('md5').update(primaryUrl).digest('hex').substring(0, 8) : 'none';
    const sizeTag = `sq${POSTER_SIZE}`;
    return path.join(cacheDir, `${cId}_${urlHash}_${sizeTag}.png`);
}

/**
 * Retrieves or generates a cached poster for a channel.
 *
 * Supports an extended call with a fallback logo URL and channel name as additional arguments.
 *
 * @param {string} cId - The channel identifier.
 * @param {string} logoUrl - The primary logo URL.
 * @param {string} fallbackName - The channel name used for fallback poster generation.
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

    // Validate channel ID to prevent path traversal (CodeQL: path injection).
    // Channel ids embed iptv-org country suffixes (e.g. uk_SkySportsNews.uk),
    // so dots are legal; only reject anything that could traverse (slashes,
    // backslashes, .. sequences) or starts with non-alphanumeric.
    if (!cId || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(cId) || cId.includes('..')) {
        throw new Error("Invalid channel ID");
    }

    // Size/resolution stamp (sq640) lives in posterPath() so the prewarm job and
    // the request path agree; a format change regenerates instead of serving a
    // stale-sized file, and old un-suffixed files are left for the cap to evict.
    const cachePath = posterPath(cId, primaryUrl);

    // Defense-in-depth: validate resolved path stays within cache directory
    const resolvedPath = path.resolve(cachePath);
    const resolvedCacheDir = path.resolve(cacheDir);
    if (!resolvedPath.startsWith(resolvedCacheDir)) {
        throw new Error("Path traversal attempt detected");
    }

    // Serve a cached poster, but NEVER permanently: a fallback SVG can ride on
    // disk and shadow re-fetching a URL that has since recovered. Return the
    // cached file while its URL is inside its (short, expiring) dead-URL retry
    // window, or while the logo worker proxy is in cooldown (quota exhausted) —
    // in both cases re-fetching is pointless, so serve the poster the server
    // already rendered instead of re-generating.
    if (fs.existsSync(cachePath) && (isDeadUrl(primaryUrl) || isWorkerInCooldown())) return cachePath;

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

/**
 * Determines whether a logo URL is within its retry window after a failed fetch.
 * @param {string} url - The logo URL to check.
 * @return {boolean} `true` if the URL is pending retry, `false` otherwise.
 */
function isLogoMissPending(url) {
    return isDeadUrl(url);
}

module.exports = { getPremiumPoster, isLogoMissPending, markDeadUrl, posterPath };
