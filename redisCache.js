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
        lastUpdated: cacheData.lastUpdated || Date.now(),
        // Config-generation stamp: a rehydrating worker checks this against its
        // own counter, so a snapshot taken from a prior config cannot be served
        // as current after a config change (see ensureCache stale check).
        generation: cacheData._generation
    });
}

/**
 * Reconstructs a cache object from its JSON representation.
 * @param {string} raw - The JSON-encoded cache data.
 * @return {Object} The cache data with map and set fields restored.
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
        lastUpdated: obj.lastUpdated || 0,
        _generation: obj.generation
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
 * Delete a channel cache entry from Redis. Drops the persisted snapshot so a
 * config change (groups, iptv-org toggle, provider) re-parses on next request
 * instead of serving the stale snapshot until it ages out.
 * @param {string} configKey
 * @return {Promise<boolean>} true when the entry is gone; false if the delete
 *   failed (caller should surface that a stale snapshot may survive).
 */
async function deleteCacheFromRedis(configKey) {
    if (!redis) return true;
    try {
        await redis.del(KEY_PREFIX + configKey);
        return true;
    } catch (e) {
        // Do not throw: a Redis outage must not fail a config save that already
        // committed. Report the failure so the caller can warn that the old
        // snapshot may be rehydrated until it ages out.
        console.error('[Redis Error] deleteCacheFromRedis:', e.message);
        return false;
    }
}

/**
 * Load a channel cache snapshot from Redis, if present.
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
 * Lists configuration keys stored in the Redis channel cache.
 * @return {Promise<string[]>} The stored configuration-key suffixes, or an empty array when Redis is unavailable or the lookup fails.
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
// Generation is a dedicated integer so bumpGeneration can INCR atomically (a
// read-modify-write on the JSON state key would lose increments under the
// multi-process cluster). TTL keeps unused EPG keys from growing unbounded.
const EPG_GEN_KEY = 'nuvio:epg:hub_generation';
const EPG_CACHE_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Saves merged EPG programs for a channel with the hub generation used to build them.
 * @param {string} channelKey - The channel's canonical identifier.
 * @param {Array} programs - The channel's merged EPG programs.
 * @param {number} generation - The hub generation associated with the programs.
 */
async function saveEpgCache(channelKey, programs, generation) {
    if (!redis) return;
    try {
        await redis.set(EPG_CACHE_PREFIX + channelKey, JSON.stringify({ generation, programs, savedAt: Date.now() }), 'EX', EPG_CACHE_TTL_SECONDS);
    } catch (e) {
        console.error('[Redis Error] saveEpgCache:', e.message);
    }
}

/**
 * Loads cached EPG programs and their generation metadata for a channel.
 * @param {string} channelKey - The key identifying the channel.
 * @return {{programs: Array, generation: number, savedAt: number}|null} The cached EPG data, or `null` when unavailable, missing, or invalid.
 */
async function loadEpgCache(channelKey) {
    if (!redis) return null;
    try {
        const raw = await redis.get(EPG_CACHE_PREFIX + channelKey);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return { programs: obj.programs || [], generation: obj.generation || 0, savedAt: obj.savedAt || 0 };
    } catch (_) {
        return null;
    }
}

/**
 * Loads cached EPG data for multiple channels.
 * @param {string[]} channelKeys - The channel keys to retrieve.
 * @return {Map<string, {programs: Array, generation: number, savedAt: number}|null>} A map of channel keys to cached EPG data, or `null` for missing or invalid entries.
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

/**
 * Retrieves the current EPG hub generation.
 * @return {number} The current generation, or `0` when unavailable or invalid.
 */
async function getHubGeneration() {
    if (!redis) return 0;
    try {
        const n = parseInt(await redis.get(EPG_GEN_KEY) || '0', 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (_) {
        return 0;
    }
}

/**
 * Advances the central EPG hub generation and records cycle coverage.
 * INCR is atomic across the multi-process cluster, so concurrent bumps never
 * lose an increment (the old read-modify-write could), and the returned value
 * is the generation this cycle is now authoritative at — callers must stamp
 * their cache writes with it rather than deriving generation + 1 locally.
 * Coverage and last_update are stored on the state key, which no longer
 * carries the generation.
 * @param {number} coverage - The coverage value to store with the updated generation.
 * @return {number} The new generation, or `0` when Redis is unavailable.
 */
async function bumpGeneration(coverage) {
    if (!redis) return 0;
    try {
        const gen = await redis.incr(EPG_GEN_KEY);
        await redis.set(EPG_STATE_KEY, JSON.stringify({ last_update: Date.now(), coverage: coverage || 0 }));
        return gen;
    } catch (e) {
        console.error('[Redis Error] bumpGeneration:', e.message);
        return 0;
    }
}

/**
 * Records cycle coverage without advancing the hub generation, and returns the
 * current generation. Used to publish final coverage after cache entries have
 * already been stamped with the cycle's reserved generation.
 * @param {number} coverage - The coverage value to store.
 * @return {Promise<number>} The current generation, or `0` when Redis is unavailable.
 */
async function setHubState(coverage) {
    if (!redis) return 0;
    try {
        const gen = parseInt(await redis.get(EPG_GEN_KEY) || '0', 10) || 0;
        await redis.set(EPG_STATE_KEY, JSON.stringify({ last_update: Date.now(), coverage: coverage || 0 }));
        return gen;
    } catch (e) {
        console.error('[Redis Error] setHubState:', e.message);
        return 0;
    }
}

/**
 * Runs a DB-global background job exactly once per cadence across the whole
 * cluster. Every worker registers the same periodic timers, but only the worker
 * that wins the NX-lock actually executes the job body; the others skip this
 * cycle. The lock is released (compare-and-delete of our own token) when the job
 * finishes, and auto-expires via TTL if the holder crashes mid-run, so the next
 * cadence can always re-acquire. When Redis is unavailable it runs directly,
 * preserving the single-process behavior (one scheduler, nothing to dedupe).
 *
 * Intended for durable, DB-driven jobs (EPG hub merge, prewarm, history prune).
 * Jobs that read a worker's in-memory userCaches must NOT be gated here — each
 * worker legitimately processes its own caches.
 * @param {string} lockName - Stable name identifying the job (lock key suffix).
 * @param {number} ttlSeconds - Lock TTL; a safety net for crashes, so make it
 *   comfortably exceed the longest expected job runtime.
 * @param {Function} fn - The job to run; may return a promise.
 * @return {Promise<boolean>} `true` if this worker ran the job, `false` if it
 *   skipped because another worker holds the lock this cycle.
 */
async function withOnceLock(lockName, ttlSeconds, fn) {
    if (!redis) return fn();
    const key = 'nuvio:lock:' + lockName;
    const token = crypto.randomUUID();
    try {
        const acquired = (await redis.set(key, token, 'EX', ttlSeconds, 'NX')) === 'OK';
        if (!acquired) return false;
    } catch (e) {
        // Lock infra unavailable: don't drop the job, run it unguarded.
        console.error(`[Lock] ${lockName} acquire failed, running unguarded:`, e.message);
        return fn();
    }
    try {
        return await fn();
    } finally {
        const lua = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
        try { await redis.eval(lua, 1, key, token); } catch (e) { console.error(`[Lock] ${lockName} release failed:`, e.message); }
    }
}

// --- Shared auth sessions (multi-worker safe) ------------------------------
// Sessions were an in-memory Map (single-process only). For horizontal scaling
// to more workers, a token must validate on ANY worker — stored in Redis with a
// 30-day TTL (matches the previous in-memory expiry). Node cluster / replicas
// only work once this is Redis-backed.
const SESSION_PREFIX = 'nuvio:session:';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; /**
 * Retrieves a shared session by its token.
 * @param {string} token - The session token.
 * @return {Object|null} The parsed session data, or `null` if the token is missing, the session is unavailable, or the stored data is invalid.
 */

async function sessionGet(token) {
    if (!redis || !token) return null;
    try {
        const raw = await redis.get(SESSION_PREFIX + token);
        if (!raw) return null;
        const s = JSON.parse(raw);
        return s || null;
    } catch { return null; }
}

/**
 * Stores a shared session with a 30-day expiration.
 * @param {string} token - The token associated with the session.
 * @param {Object} session - The session data to store.
 */
async function sessionSet(token, session) {
    if (!redis || !token) return;
    try {
        await redis.set(SESSION_PREFIX + token, JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
    } catch (e) { console.error('[Redis Error] sessionSet:', e.message); }
}

/**
 * Deletes a shared session.
 * @param {string} token - The session token identifying the session.
 */
async function sessionDelete(token) {
    if (!redis || !token) return;
    try { await redis.del(SESSION_PREFIX + token); } catch {}
}

/**
 * Remove expired or invalid shared session records.
 * @return {number} The number of session records removed.
 */
async function sessionPruneExpired() {
    if (!redis) return 0;
    let cleared = 0;
    try {
        let cursor = '0';
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', SESSION_PREFIX + '*', 'COUNT', 200);
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
    deleteCacheFromRedis,
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
    setHubState,
    withOnceLock,
    sessionGet,
    sessionSet,
    sessionDelete,
    sessionPruneExpired,
    hasRedis: !!redis
};