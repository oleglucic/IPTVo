// streamSessions.js
// Redis-backed session tracking for concurrency-limited streaming proxy.
// Uses the existing Redis connection pattern from redisCache.js — same
// REDIS_URL, same ioredis configuration, shared client across modules.

const crypto = require('crypto');
const { hasRedis, redisClient } = require('./redisCache');
const log = require('./logger').for('streamSessions');

const redis = hasRedis ? redisClient : null;
if (!redis) {
    log.warn('Redis not available for session tracking - concurrency limiting disabled.');
}

// --- Sorted set: sessions:{userId} ------------------------------------------------
// Member: sessionId (UUID v4 string), Score: lastActivityAt (epoch ms)
// Used to find least-recently-active session via ZRANGEBYSCORE or ZMIN.

const SESSION_SORTED_SET_PREFIX = 'sessions:';

// --- Hash: session:{sessionId} ---------------------------------------------------
// Fields: userId, channelId, startedAt (epoch ms), status,
//         evictionTargetSessionId (set only when status === "countdown")
// TTL: 4 hours orphan safety net set on hash creation

const SESSION_HASH_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours

/**
 * Generates a UUID v4 string.
 * @returns {string}
 */
function v4Uuid() {
    return crypto.randomUUID();
}

/**
 * Writes the session hash with a TTL safety net.
 * @param {string} sessionId
 * @param {Object} fields - Key-value fields to set in the hash
 */
async function writeSessionHash(sessionId, fields) {
    if (!redis) return;
    try {
        await redis.hset(SESSION_HASH_PREFIX + sessionId, fields);
        await redis.expire(SESSION_HASH_PREFIX + sessionId, SESSION_TTL_SECONDS);
    } catch (e) {
        log.error('writeSessionHash error:', e.message);
    }
}

/**
 * Adds a member to the user's sorted set with a score.
 * @param {string} userId
 * @param {string} sessionId
 * @param {number} score - epoch ms score (lastActivityAt)
 */
async function addToSortedSet(userId, sessionId, score) {
    if (!redis) return;
    try {
        await redis.zadd(SESSION_SORTED_SET_PREFIX + userId, [{ score, value: sessionId }]);
    } catch (e) {
        log.error('addToSortedSet error:', e.message);
    }
}

/**
 * Removes a member from the user's sorted set.
 * @param {string} userId
 * @param {string} sessionId
 */
async function removeFromSortedSet(userId, sessionId) {
    if (!redis) return;
    try {
        await redis.zrem(SESSION_SORTED_SET_PREFIX + userId, sessionId);
    } catch (e) {
        log.error('removeFromSortedSet error:', e.message);
    }
}

/**
 * Creates a new session for a user channel.
 * @param {string} userId
 * @param {string} channelId
 * @param {string} [rendition] - optional rendition value, defaults to 'source'
 * @returns {Promise<string|null>} The new sessionId, or null without Redis.
 */
async function createSession(userId, channelId, rendition) {
    if (!redis) return null;
    const sessionId = v4Uuid();
    const now = Date.now();
    const r = rendition || 'source';

    // Write the hash
    await writeSessionHash(sessionId, {
        userId,
        channelId,
        startedAt: now,
        status: 'active',
        rendition: r,
    });

    // Add to sorted set
    await addToSortedSet(userId, sessionId, now);

    log.info(`Created session ${sessionId} for user ${userId}, channel ${channelId}`);
    return sessionId;
}

/**
 * Atomically reserves an active provider slot and creates its session.
 * Returns null when the user's limit has already been reached.
 * @param {string} userId
 * @param {string} channelId
 * @param {number} limit
 * @returns {Promise<string|null>}
 */
async function reserveSessionSlot(userId, channelId, limit) {
    if (!redis) return null;
    // Defensive: the Lua script below rejects with `ZCARD >= limit`, which
    // would reject EVERY reservation if limit were 0 or negative (0 was
    // never meant to reach this function at all — the caller in server.js
    // treats 0 as "unlimited" and calls createSession() directly instead —
    // but that's a call-site convention, not something this function can
    // assume forever. Falling through to createSession() here means this
    // function is correct on its own terms regardless of what any caller
    // does, rather than silently locking out every "unlimited" user if a
    // future caller ever invokes this directly with limit=0.
    if (!Number.isFinite(limit) || limit <= 0) {
        return createSession(userId, channelId);
    }

    const sessionId = v4Uuid();
    const now = Date.now();
    const reserved = await redis.eval(
        `if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
            return 0
        end
        redis.call('HSET', KEYS[2],
            'userId', ARGV[2],
            'channelId', ARGV[3],
            'startedAt', ARGV[4],
            'status', 'active')
        redis.call('EXPIRE', KEYS[2], ARGV[5])
        redis.call('ZADD', KEYS[1], ARGV[4], ARGV[6])
        return 1`,
        2,
        SESSION_SORTED_SET_PREFIX + userId,
        SESSION_HASH_PREFIX + sessionId,
        limit,
        userId,
        channelId,
        now,
        SESSION_TTL_SECONDS,
        sessionId
    );

    if (reserved !== 1) return null;
    log.info(`Reserved session ${sessionId} for user ${userId}, channel ${channelId}`);
    return sessionId;
}

/**
 * Updates the sorted set score for a session (lastActivityAt).
 * Call on every segment/playlist HTTP request through the relay.
 * @param {string} sessionId
 * @param {string} userId
 */
async function touchSession(sessionId, userId) {
    if (!redis) return;
    try {
        await redis.zadd(SESSION_SORTED_SET_PREFIX + userId, [{ score: Date.now(), value: sessionId }]);
        // Also update the hash's lastActivityAt field for reference
        await writeSessionHash(sessionId, { lastActivityAt: Date.now() });
    } catch (e) {
        log.error('touchSession error:', e.message);
    }
}

/**
 * Returns the current count of open sessions for a user.
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function countActiveSessions(userId) {
    if (!redis) return 0;
    try {
        return await redis.zcard(SESSION_SORTED_SET_PREFIX + userId);
    } catch (e) {
        log.error('countActiveSessions error:', e.message);
        return 0;
    }
}

/**
 * Returns the sessionId with the LOWEST score (least recently active),
 * excluding excludeSessionId. Returns null if nothing to evict.
 * @param {string} userId
 * @param {string} excludeSessionId
 * @returns {Promise<string|null>}
 */
async function getLeastRecentlyActiveSession(userId, excludeSessionId) {
    if (!redis) return null;
    try {
        // ZRANGE with score to get members sorted by score (ascending)
        const members = await redis.zrange(SESSION_SORTED_SET_PREFIX + userId, 0, -1, 'WITHSCORES');
        if (!members || members.length === 0) return null;

        // Find the lowest score member, excluding the new session
        let leastSessionId = null;
        let leastScore = Infinity;

        for (let i = 0; i < members.length; i += 2) {
            const sid = members[i];
            const score = members[i + 1];
            if (sid !== excludeSessionId && score < leastScore) {
                leastScore = score;
                leastSessionId = sid;
            }
        }

        if (leastSessionId === null) return null;
        return leastSessionId;
    } catch (e) {
        log.error('getLeastRecentlyActiveSession error:', e.message);
        return null;
    }
}

/**
 * Sets status = "countdown" and evictionTargetSessionId on the session hash.
 * @param {string} sessionId
 * @param {string} evictionTargetSessionId
 */
async function markCountdown(sessionId, evictionTargetSessionId) {
    if (!redis) return;
    try {
        await writeSessionHash(sessionId, {
            status: 'countdown',
            evictionTargetSessionId,
        });
        log.info(`Session ${sessionId} marked as countdown, targeting ${evictionTargetSessionId}`);
    } catch (e) {
        log.error('markCountdown error:', e.message);
    }
}

/**
 * Sets status = "active" and clears evictionTargetSessionId.
 * @param {string} sessionId
 */
async function markActive(sessionId) {
    if (!redis) return;
    try {
        await writeSessionHash(sessionId, { status: 'active' });
        await redis.hdel(SESSION_HASH_PREFIX + sessionId, 'evictionTargetSessionId');
        log.info(`Session ${sessionId} marked as active`);
    } catch (e) {
        log.error('markActive error:', e.message);
    }
}

/**
 * Claims countdown eviction handling for one request across all workers.
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function claimEviction(sessionId) {
    if (!redis) return false;
    return (await redis.hsetnx(SESSION_HASH_PREFIX + sessionId, 'evictionHandled', '1')) === 1;
}

/**
 * Returns the full session hash as a plain object, or null if it doesn't exist.
 * @param {string} sessionId
 * @returns {Promise<Object|null>}
 */
async function getSession(sessionId) {
    if (!redis) return null;
    try {
        const raw = await redis.hgetall(SESSION_HASH_PREFIX + sessionId);
        if (!raw || Object.keys(raw).length === 0) return null;
        return raw;
    } catch (e) {
        log.error('getSession error:', e.message);
        return null;
    }
}

/**
 * Removes the session from both the sorted set and deletes the hash.
 * @param {string} sessionId
 * @param {string} userId
 */
async function destroySession(sessionId, userId) {
    if (!redis) return;
    try {
        // Remove from sorted set
        await removeFromSortedSet(userId, sessionId);
        // Delete the hash
        await redis.del(SESSION_HASH_PREFIX + sessionId);
        log.info(`Destroyed session ${sessionId} for user ${userId}`);
    } catch (e) {
        log.error('destroySession error:', e.message);
    }
}

/**
 * Scans ALL sessions:* sorted sets (using SCAN, not KEYS), finds every session
 * whose score (lastActivityAt) is older than the appropriate threshold,
 * and for each one: calls stopFfmpegForSession and then destroySession.
 * 
 * For countdown sessions: uses a short grace period (at least 4 seconds or
 * twice the HLS segment duration) to detect viewer disconnect.
 * For active sessions: uses the provided idleTimeoutMs.
 * 
 * If a countdown session is idle, only that session is cleaned up (the
 * eviction target is NOT touched — the original stream keeps playing).
 * 
 * Returns the count of sessions cleaned up.
 * @param {number} idleTimeoutMs - Idle timeout for active sessions
 * @returns {Promise<number>}
 */
async function reapIdleSessions(idleTimeoutMs) {
    if (!redis) return 0;

    const now = Date.now();
    let cleanedCount = 0;

    // HLS segment durations (from streamRelay.js):
    // - Real streams: hls_time = 4 seconds
    // - Countdown streams: hls_time = 2 seconds
    const COUNTDOWN_HLS_TIME_MS = 2000; // 2 seconds
    const COUNTDOWN_GRACE_MS = Math.max(4000, COUNTDOWN_HLS_TIME_MS * 2); // 4000ms = 4 seconds

    try {
        // Scan all session sorted sets using SCAN (non-blocking)
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${SESSION_SORTED_SET_PREFIX}*`, 'COUNT', 100);
            cursor = nextCursor;

            if (keys && keys.length) {
                for (const key of keys) {
                    const userId = key.substring(SESSION_SORTED_SET_PREFIX.length);
                    // Get all members with scores from this sorted set
                    const members = await redis.zrange(SESSION_SORTED_SET_PREFIX + userId, 0, -1, 'WITHSCORES');

                    if (members && members.length > 0) {
                        // Process members in pairs (sessionId, score)
                        for (let i = 0; i < members.length; i += 2) {
                            const sessionId = members[i];
                            const lastActivityAt = members[i + 1];

                            // Get session to check its status
                            const session = await getSession(sessionId);
                            if (!session) {
                                await removeFromSortedSet(userId, sessionId);
                                continue;
                            }

                            const status = session.status;
                            let threshold;

                            if (status === 'countdown') {
                                // Short grace period for countdown sessions
                                threshold = now - COUNTDOWN_GRACE_MS;
                            } else {
                                // Regular idle timeout for active/pending_eviction/evicted sessions
                                threshold = now - idleTimeoutMs;
                            }

                            if (lastActivityAt < threshold) {
                                // Session is idle - clean it up
                                try {
                                    // For countdown sessions, only clean up the countdown session itself
                                    // Do NOT touch the evictionTargetSessionId - the original stream keeps playing
                                    const { stopFfmpegForSession } = require('./streamRelay');
                                    await stopFfmpegForSession(sessionId);

                                    // Destroy the session
                                    await destroySession(sessionId, userId);
                                    cleanedCount++;
                                    log.info(`Reaped idle ${status} session ${sessionId} (lastActivityAt=${lastActivityAt})`);
                                } catch (e) {
                                    log.error(`Failed to reap session ${sessionId}:`, e.message);
                                }
                            }
                        }
                    }
                }
            }
        } while (cursor !== '0');
    } catch (e) {
        log.error('reapIdleSessions error:', e.message);
    }

    return cleanedCount;
}

module.exports = {
    createSession,
    reserveSessionSlot,
    touchSession,
    countActiveSessions,
    getLeastRecentlyActiveSession,
    markCountdown,
    markActive,
    claimEviction,
    getSession,
    destroySession,
    reapIdleSessions,
};
