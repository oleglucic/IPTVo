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
        retryStrategy: (times) => Math.min(times * 200, 2000),
        protocol: 2  // ioredis v6 defaults to RESP3; use RESP2 for compatibility
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
        epgMap: Object.fromEntries(cacheData.epgMap || new Map()), // retained for decoupled EPG refresh
        epgLastUpdated: cacheData.epgLastUpdated || 0,
        epgNextRefreshAt: cacheData.epgNextRefreshAt || 0,
        epgCoverageMs: cacheData.epgCoverageMs || 0,
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
        epgMap: new Map(Object.entries(obj.epgMap || {})), // retained for decoupled EPG refresh
        epgLastUpdated: obj.epgLastUpdated || 0,
        epgNextRefreshAt: obj.epgNextRefreshAt || 0,
        epgCoverageMs: obj.epgCoverageMs || 0,
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

// --- Central EPG cache (generation-stamped, not arbitrary TTL) --------------
// The central EPG DB (epg_programs) is the source of truth. User requests read
// this Redis cache, which is valid for as long as the central DB's data hasn't
// been renewed — tracked by a hub `generation` rather than a fixed TTL. When
// the hub (epgHub) re-fetches and bumps the generation, stale cache entries are
// rebuilt from the DB. So the cache lives exactly as long as the DB has data.
const EPG_CACHE_PREFIX = 'nuvio:epg:';
const EPG_STATE_KEY = 'nuvio:epg:hub_state';

/**
 * Save a channel's merged EPG to the cache, stamped with the hub generation it
 * was built from.
 * @param {string} channelKey canonical cId
 * @param {Array} programs [{title,desc,start,stop}]
 * @param {number} generation current hub generation (from getHubGeneration)
 */
async function saveEpgCache(channelKey, programs, generation) {
    if (!redis) return;
    try {
        await redis.set(EPG_CACHE_PREFIX + channelKey, JSON.stringify({ generation, programs, savedAt: Date.now() }));
    } catch (e) {
        console.error('[Redis Error] saveEpgCache:', e.message);
    }
}

/**
 * Load a channel's EPG cache. Returns { programs, generation, savedAt } or null
 * on miss. Validity is decided by the caller comparing `generation` to the
 * current hub generation (see getHubGeneration).
 */
async function loadEpgCache(channelKey) {
    if (!redis) return null;
    try {
        const raw = await redis.get(EPG_CACHE_PREFIX + channelKey);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return { programs: obj.programs || [], generation: obj.generation || 0, savedAt: obj.savedAt || 0 };
    } catch (e) {
        return null;
    }
}

/**
 * Batch-load EPG cache entries for many channels with ONE Redis MGET (avoids a
 * round-trip per channel — important when a catalog page resolves 100 channels).
 * Returns a Map<channelKey, {programs,generation,savedAt}|null>.
 */
async function mgetEpgCaches(channelKeys) {
    const out = new Map();
    if (!redis || !channelKeys || channelKeys.length === 0) return out;
    try {
        const raws = await redis.mget(channelKeys.map((k) => EPG_CACHE_PREFIX + k));
        for (let i = 0; i < channelKeys.length; i++) {
            const raw = raws[i];
            if (!raw) { out.set(channelKeys[i], null); continue; }
            try {
                const obj = JSON.parse(raw);
                out.set(channelKeys[i], { programs: obj.programs || [], generation: obj.generation || 0, savedAt: obj.savedAt || 0 });
            } catch { out.set(channelKeys[i], null); }
        }
    } catch (e) {
        console.error('[Redis Error] mgetEpgCaches:', e.message);
    }
    return out;
}

/** Current hub generation (0 if never bumped). */
async function getHubGeneration() {
    if (!redis) return 0;
    try {
        const raw = await redis.get(EPG_STATE_KEY);
        if (!raw) return 0;
        const obj = JSON.parse(raw);
        return (obj && obj.generation) || 0;
    } catch (e) {
        return 0;
    }
}

/** Bump the hub generation (called after a successful central-EPG merge cycle). */
async function bumpGeneration(coverage) {
    if (!redis) return;
    try {
        const raw = await redis.get(EPG_STATE_KEY);
        const prev = raw ? (JSON.parse(raw).generation || 0) : 0;
        await redis.set(EPG_STATE_KEY, JSON.stringify({ generation: prev + 1, last_update: Date.now(), coverage: coverage || 0 }));
    } catch (e) {
        console.error('[Redis Error] bumpGeneration:', e.message);
    }
}

// --- Shared auth sessions (multi-worker safe) ------------------------------
// Sessions were an in-memory Map (single-process only). For horizontal scaling
// to more workers, a token must validate on ANY worker — stored in Redis with a
// 30-day TTL (matches the previous in-memory expiry). Node cluster / replicas
// only work once this is Redis-backed.
const SESSION_PREFIX = 'nuvio:session:';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

async function sessionGet(token) {
    if (!redis || !token) return null;
    try {
        const raw = await redis.get(SESSION_PREFIX + token);
        if (!raw) return null;
        const s = JSON.parse(raw);
        return s || null;
    } catch { return null; }
}

async function sessionSet(token, session) {
    if (!redis || !token) return;
    try {
        await redis.set(SESSION_PREFIX + token, JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
    } catch (e) { console.error('[Redis Error] sessionSet:', e.message); }
}

async function sessionDelete(token) {
    if (!redis || !token) return;
    try { await redis.del(SESSION_PREFIX + token); } catch {}
}

/**
 * Remove expired sessions. Redis auto-expires them on TTL, but this also prunes
 * any session whose expiresAt passed without a TTL fire. Returns count scanned.
 */
async function sessionPruneExpired() {
    if (!redis) return 0;
    let cleared = 0;
    try {
        let cursor = '0';
        do {
            const [next, keys] = await redis.scan(cursor, { match: SESSION_PREFIX + '*', count: 200 });
            cursor = next;
            if (keys && keys.length) {
                const raws = await redis.mget(keys);
                const now = Date.now();
                const toDel = [];
                for (let i = 0; i < keys.length; i++) {
                    try {
                        const s = raws[i] ? JSON.parse(raws[i]) : null;
                        if (!s || (s.expiresAt && s.expiresAt < now)) toDel.push(keys[i]);
                    } catch { toDel.push(keys[i]); }
                }
                if (toDel.length) { await redis.del(toDel); cleared += toDel.length; }
            }
        } while (cursor !== '0');
    } catch (e) { console.error('[Redis Error] sessionPrune:', e.message); }
    return cleared;
}

module.exports = {
    saveCacheToRedis,
    loadCacheFromRedis,
    listCachedConfigKeys,
    saveLogoBuffer,
    loadLogoBuffer,
    saveLogoUrl,
    loadLogoUrl,
    saveEpgCache,
    loadEpgCache,
    mgetEpgCaches,
    getHubGeneration,
    bumpGeneration,
    sessionGet,
    sessionSet,
    sessionDelete,
    sessionPruneExpired,
    hasRedis: !!redis
};