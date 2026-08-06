const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const DEAD_URL_TTL = 6 * 60 * 60 * 1000; // 6h - retry dead URLs periodically in case provider fixes them
const MAX_CACHE_FILES = 5000; // soft cap on disk cache to avoid unbounded growth
const FETCH_TIMEOUT = 7000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB - reject absurd payloads before sharp touches them

const deadUrlCache = new Map(); // logoUrl -> timestamp of last known failure
const inFlight = new Map();     // cId -> Promise, de-dupes concurrent requests for the same poster

function isDeadUrl(url) {
    const failedAt = deadUrlCache.get(url);
    if (!failedAt) return false;
    if (Date.now() - failedAt > DEAD_URL_TTL) {
        deadUrlCache.delete(url);
        return false;
    }
    return true;
}

function markDeadUrl(url) {
    deadUrlCache.set(url, Date.now());
}

// Deterministic accent color per channel name so the same channel always renders
// the same color, rather than a random one on every fallback regeneration.
function colorForName(name) {
    const palette = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
    const hash = crypto.createHash('md5').update(name || 'unknown').digest();
    return palette[hash[0] % palette.length];
}

function initialsForName(name) {
    if (!name) return '?';
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

async function generateFallback(cachePath, fallbackName) {
    const cleanName = fallbackName ? fallbackName.toUpperCase() : "LIVE TV";
    const accent = colorForName(fallbackName);
    const initials = initialsForName(fallbackName);

    const fallbackSvg = `
        <svg width="600" height="900" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#1e293b" />
                    <stop offset="100%" stop-color="#0f172a" />
                </linearGradient>
                <radialGradient id="glow" cx="50%" cy="45%" r="45%">
                    <stop offset="0%" stop-color="${accent}" stop-opacity="0.35" />
                    <stop offset="100%" stop-color="${accent}" stop-opacity="0" />
                </radialGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#bg)"/>
            <rect x="20" y="20" width="560" height="860" rx="18" fill="none" stroke="#1e293b" stroke-width="4"/>
            <circle cx="300" cy="400" r="220" fill="url(#glow)" />
            <circle cx="300" cy="400" r="90" fill="${accent}" fill-opacity="0.15" stroke="${accent}" stroke-width="3"/>
            <text x="300" y="418" font-family="Inter, sans-serif" font-size="56" font-weight="bold" fill="${accent}" text-anchor="middle">${initials}</text>
            <text x="300" y="560" font-family="Inter, sans-serif" font-size="32" font-weight="bold" fill="#e2e8f0" text-anchor="middle">${cleanName}</text>
        </svg>
    `;
    await sharp(Buffer.from(fallbackSvg)).toFile(cachePath);
    return cachePath;
}

async function renderPoster(cId, logoUrl, fallbackName, cachePath) {
    if (isDeadUrl(logoUrl)) {
        return generateFallback(cachePath, fallbackName);
    }

    try {
        if (!logoUrl || !logoUrl.startsWith('http')) throw new Error("Invalid or missing logo URL");

        const response = await axios.get(logoUrl, {
            responseType: 'arraybuffer',
            timeout: FETCH_TIMEOUT,
            maxContentLength: MAX_IMAGE_BYTES,
            validateStatus: s => s === 200
        });

        const contentType = response.headers['content-type'] || '';
        if (!contentType.startsWith('image/')) {
            throw new Error(`Non-image content-type: ${contentType}`);
        }

        const logoBuffer = Buffer.from(response.data);

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
        if (logoUrl) markDeadUrl(logoUrl);
        return generateFallback(cachePath, fallbackName);
    }
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