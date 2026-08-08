// redisCache.js
// Persists the in-memory channel cache (userCaches entries) to Redis, so a
// container restart can rehydrate instantly instead of re-parsing the whole
// M3U/Xtream source from scratch. The in-memory Map stays the fast path for
// every request; Redis is purely the durability layer behind it.

const Redis = require('ioredis');
const crypto = require('crypto');

const redisUrl = process.env.REDIS_URL;
let redis = null;

if (redisUrl) {
    redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => Math.min(times * 200, 2000)
    });
    redis.on('error', (e) => console.error('[Redis Error]', e.message));
    redis.on('connect', () => console.log('[Redis] Connected.'));
} else {
    console.warn('[Redis] REDIS_URL not set - cache persistence disabled, running memory-only.');
}

const KEY_PREFIX = 'nuvio:cache:';
const LOGO_PREFIX = 'nuvio:logo:';
const LOGO_URL_PREFIX = 'nuvio:logo:url:';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours - well beyond MAX_CACHE_AGE, just a safety net
const LOGO_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days - logo buffers persist across restarts
const LOGO_URL_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days - URL tracking for refresh detection

/**
 * Convert an in-memory cache entry (with Map/Set fields) into a JSON-safe plain object.
 * @param {object} cacheData - the value normally stored in userCaches
 */
function serializeCache(cacheData) {
    return JSON.stringify({
        status: cacheData.status,
        channelMap: Object.fromEntries(cacheData.channelMap || new Map()),
        logoTracker: Object.fromEntries(cacheData.logoTracker || new Map()),
        catalogItems: cacheData.catalogItems || [],
        uniqueGroups: Array.from(cacheData.uniqueGroups || new Set()),
        epgData: cacheData.epgData || {},
        lastUpdated: cacheData.lastUpdated || Date.now()
    });
}

/**
 * Reverse of serializeCache - rebuild Map/Set fields from the JSON-safe plain object.
 * @param {string} raw - the JSON string read back from Redis
 */
function deserializeCache(raw) {
    const obj = JSON.parse(raw);
    return {
        status: obj.status,
        channelMap: new Map(Object.entries(obj.channelMap || {})),
        logoTracker: new Map(Object.entries(obj.logoTracker || {})),
        catalogItems: obj.catalogItems || [],
        uniqueGroups: new Set(obj.uniqueGroups || []),
        epgData: obj.epgData || {},
        lastUpdated: obj.lastUpdated || 0
    };
}

/**
 * Write a channel cache entry through to Redis. Fire-and-forget safe - errors
 * are logged, never thrown, since Redis is a durability layer, not the source of truth.
 * @param {string} configKey
 * @param {object} cacheData
 */
async function saveCacheToRedis(configKey, cacheData) {
    if (!redis) return;
    try {
        await redis.set(KEY_PREFIX + configKey, serializeCache(cacheData), 'EX', CACHE_TTL_SECONDS);
    } catch (e) {
        console.error('[Redis Error] saveCacheToRedis:', e.message);
    }
}

/**
 * Load a channel cache entry from Redis, if present.
 * @param {string} configKey
 * @returns {Promise<object | null>}
 */
async function loadCacheFromRedis(configKey) {
    if (!redis) return null;
    try {
        const raw = await redis.get(KEY_PREFIX + configKey);
        if (!raw) return null;
        return deserializeCache(raw);
    } catch (e) {
        console.error('[Redis Error] loadCacheFromRedis:', e.message);
        return null;
    }
}

/**
 * Store a logo image buffer in Redis for long-term caching.
 * @param {string} logoUrl - The original logo URL (used as key)
 * @param {Buffer} buffer - Image buffer to store
 */
async function saveLogoBuffer(logoUrl, buffer) {
    if (!redis) return;
    try {
        const key = LOGO_PREFIX + crypto.createHash('sha256').update(logoUrl).digest('hex');
        await redis.set(key, buffer, 'EX', LOGO_TTL_SECONDS);
    } catch (e) {
        console.error('[Redis Error] saveLogoBuffer:', e.message);
    }
}

/**
 * Load a logo image buffer from Redis.
 * @param {string} logoUrl - The original logo URL (used as key)
 * @returns {Promise<Buffer|null>}
 */
async function loadLogoBuffer(logoUrl) {
    if (!redis) return null;
    try {
        const key = LOGO_PREFIX + crypto.createHash('sha256').update(logoUrl).digest('hex');
        const buffer = await redis.get(key);
        if (!buffer) return null;
        // ioredis returns Buffer when using get with binary data
        const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer);
        // Skip SVG placeholders - Sharp can't process them for background blur
        // Check for various SVG formats: <svg, <?xml ... <svg, <SVG
        const header = buf.length > 0 ? buf.subarray(0, 20).toString().trim().toLowerCase() : '';
        const isSvg = header.startsWith('<svg') || header.startsWith('<?xml') && header.includes('<svg');
        if (isSvg) {
            return null; // Treat as cache miss
        }
        return buf;
    } catch (e) {
        console.error('[Redis Error] loadLogoBuffer:', e.message);
        return null;
    }
}

/**
 * Store a logo URL mapping for change detection.
 * Used to track if a channel's logo URL has changed since last fetch.
 * @param {string} channelId - The channel ID
 * @param {string} logoUrl - The logo URL
 * @param {string} source - Source of logo ('iptv-org', 'playlist', 'fallback')
 */
async function saveLogoUrl(channelId, logoUrl, source = 'unknown') {
    if (!redis) return;
    try {
        const key = LOGO_URL_PREFIX + channelId;
        const data = JSON.stringify({ url: logoUrl, source, updatedAt: Date.now() });
        await redis.set(key, data, 'EX', LOGO_URL_TTL_SECONDS);
    } catch (e) {
        console.error('[Redis Error] saveLogoUrl:', e.message);
    }
}

/**
 * Load stored logo URL for a channel to detect changes.
 * @param {string} channelId - The channel ID
 * @returns {Promise<{url: string, source: string, updatedAt: number} | null>}
 */
async function loadLogoUrl(channelId) {
    if (!redis) return null;
    try {
        const key = LOGO_URL_PREFIX + channelId;
        const data = await redis.get(key);
        if (!data) return null;
        return JSON.parse(data);
    } catch (e) {
        console.error('[Redis Error] loadLogoUrl:', e.message);
        return null;
    }
}

/**
 * List every config key currently persisted in Redis - used to pre-warm
 * the in-memory cache for all known configs on boot.
 * @returns {Promise<string[]>}
 */
async function listCachedConfigKeys() {
    if (!redis) return [];
    try {
        const keys = await redis.keys(KEY_PREFIX + '*');
        return keys.map(k => k.substring(KEY_PREFIX.length));
    } catch (e) {
        console.error('[Redis Error] listCachedConfigKeys:', e.message);
        return [];
    }
}

module.exports = {
    saveCacheToRedis,
    loadCacheFromRedis,
    listCachedConfigKeys,
    saveLogoBuffer,
    loadLogoBuffer,
    saveLogoUrl,
    loadLogoUrl,
    hasRedis: !!redis
};