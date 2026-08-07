const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const DEAD_URL_TTL_BASE = 6 * 60 * 60 * 1000; // 6h base TTL for dead URLs
const DEAD_URL_TTL_MAX = 24 * 60 * 60 * 1000; // 24h max TTL
const MAX_CACHE_FILES = 5000; // soft cap on disk cache to avoid unbounded growth
const FETCH_TIMEOUT = 7000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB - reject absurd payloads before sharp touches them
const LOGO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes - cache fetched logos in memory
const LOGO_CACHE_MAX_SIZE = 1000; // max entries in logo cache
const RATE_LIMIT_INTERVAL = 1000; // 1 second
const RATE_LIMIT_MAX = 5; // max requests per interval

const deadUrlCache = new Map(); // logoUrl -> {timestamp: number, failCount: number}
const inFlight = new Map();     // cId -> Promise, de-dupes concurrent requests for the same poster
const logoCache = new Map();    // url -> {buffer: Buffer, timestamp: number}
const requestTimestamps = [];   // timestamps of recent logo fetch requests

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

async function waitForRateLimit() {
    const now = Date.now();
    // Remove timestamps older than interval
    while (requestTimestamps.length && now - requestTimestamps[0] > RATE_LIMIT_INTERVAL) {
        requestTimestamps.shift();
    }
    if (requestTimestamps.length >= RATE_LIMIT_MAX) {
        // Need to wait until the oldest timestamp expires
        const waitTime = RATE_LIMIT_INTERVAL - (now - requestTimestamps[0]) + 1; // +1 ms to be safe
        if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            // After waiting, reclean
            return waitForRateLimit();
        }
    }
    requestTimestamps.push(now);
}

async function renderPoster(cId, logoUrl, fallbackName, cachePath) {
    // Check in-memory logo cache first
    const cachedBuffer = getFromLogoCache(logoUrl);
    if (cachedBuffer) {
        // Use cached buffer to generate poster
        try {
            const background = await sharp(cachedBuffer)
                .resize(600, 900, { fit: 'cover' })
                .blur(35)
                .linear(0.55, 0)
                .toBuffer();

            const haloSvg = `
                <svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <radialGradient id="haloGlow" cx="50%" cy="50%" r="50%">
                            <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35" />
                            <stop offset="60%" stop-color="#ffffff" stop-opacity="0.15" />
                            <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0" />
                        </radialGradient>
                    </defs>
                    <circle cx="250" cy="250" r="250" fill="url(#haloGlow)" />
                </svg>
            `;
            const haloBuffer = Buffer.from(haloSvg);

            const foreground = await sharp(cachedBuffer)
                .resize(400, 400, { fit: 'inside' })
                .toBuffer();

            await sharp(background)
                .composite([
                    { input: haloBuffer, gravity: 'center' },
                    { input: foreground, gravity: 'center' }
                ])
                .toFile(cachePath);

            return cachePath;
        } catch (sharpErr) {
            console.error(`[imageEngine] Sharp processing failed for cId=${cId} (cached logo): ${sharpErr.message}`);
            // Fall back to fetching fresh logo
        }
    }

    if (isDeadUrl(logoUrl)) {
        return generateFallback(cachePath, fallbackName);
    }

    try {
        await waitForRateLimit(); // enforce rate limit before request

        if (!logoUrl || !logoUrl.startsWith('http')) throw new Error("Invalid or missing logo URL");

        const response = await axios.get(logoUrl, {
            responseType: 'arraybuffer',
            timeout: FETCH_TIMEOUT,
            maxContentLength: MAX_IMAGE_BYTES,
            validateStatus: s => s === 200 || s === 429 // we'll handle 429 specially
        });

        if (response.status === 429) {
            console.warn(`[imageEngine] Rate limited (429) for logoUrl=${logoUrl}`);
            markDeadUrl(logoUrl, false); // increase fail count
            return generateFallback(cachePath, fallbackName);
        }

        const contentType = response.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
            throw new Error(`Non-image content-type: ${contentType}`);
        }

        const logoBuffer = Buffer.from(response.data);
        // Cache the fetched logo buffer
        setLogoCache(logoUrl, logoBuffer);
        markDeadUrl(logoUrl, true); // success, reset fail count

        const background = await sharp(logoBuffer)
            .resize(600, 900, { fit: 'cover' })
            .blur(35)
            .linear(0.55, 0)
            .toBuffer();

        const haloSvg = `
            <svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <radialGradient id="haloGlow" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35" />
                        <stop offset="60%" stop-color="#ffffff" stop-opacity="0.15" />
                        <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0" />
                    </radialGradient>
                </defs>
                <circle cx="250" cy="250" r="250" fill="url(#haloGlow)" />
            </svg>
        `;
        const haloBuffer = Buffer.from(haloSvg);

        const foreground = await sharp(logoBuffer)
            .resize(400, 400, { fit: 'inside' })
            .toBuffer();

        await sharp(background)
            .composite([
                { input: haloBuffer, gravity: 'center' },
                { input: foreground, gravity: 'center' }
            ])
            .toFile(cachePath);

        return cachePath;
    } catch (err) {
        console.error(`[imageEngine] Poster generation failed for cId=${cId}, logoUrl=${logoUrl}: ${err.message}`);
        if (logoUrl) markDeadUrl(logoUrl, false);
        return generateFallback(cachePath, fallbackName);
    }
}

function generateFallback(cachePath, fallbackName) {
    const text = fallbackName || 'Live TV';
    const svg = `
        <svg width="600" height="900" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#0f172a" />
                    <stop offset="100%" stop-color="#1e293b" />
                </linearGradient>
            </defs>
            <rect width="600" height="900" fill="url(#bgGrad)" />
            <text x="300" y="450" text-anchor="middle" dominant-baseline="middle"
                  font-family="system-ui, -apple-system, sans-serif" font-size="42" font-weight="600" fill="#94a3b8">
                ${text}
            </text>
        </svg>
    `;
    return sharp(Buffer.from(svg))
        .resize(600, 900, { fit: 'fill' })
        .toFile(cachePath);
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

async function getPremiumPoster(cId, logoUrl, fallbackName) {
    const urlHash = logoUrl ? crypto.createHash('md5').update(logoUrl).digest('hex').substring(0, 8) : 'none';
    const cachePath = path.join(cacheDir, `${cId}_${urlHash}.png`);

    if (fs.existsSync(cachePath)) return cachePath;

    // De-dupe concurrent requests for the same poster (e.g. two Stremio clients loading the catalog at once)
    const inFlightKey = cachePath;
    if (inFlight.has(inFlightKey)) {
        return inFlight.get(inFlightKey);
    }

    const promise = renderPoster(cId, logoUrl, fallbackName, cachePath)
        .finally(() => {
            inFlight.delete(inFlightKey);
            evictOldestIfOverCap();
        });

    inFlight.set(inFlightKey, promise);
    return promise;
}

module.exports = { getPremiumPoster };