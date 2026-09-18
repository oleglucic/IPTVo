// streamSessions.js
// Redis-backed session tracking for concurrency-limited streaming proxy.
// Uses the existing Redis connection pattern from redisCache.js — same
// REDIS_URL, same ioredis configuration, shared client across modules.
//
// Provider concurrency counts *distinct channels* (upstream pulls), not devices.
// Multiple clients watching the same channel share one session / ffmpeg and
// only touch activity on the shared session.

const crypto = require('crypto');
const { hasRedis, redisClient } = require('./redisCache');
const log = require('./logger').for('streamSessions');

const redis = hasRedis ? redisClient : null;
if (!redis) {
    log.warn('Redis not available for session tracking - concurrency limiting disabled.');
}

const SESSION_SORTED_SET_PREFIX = 'sessions:';
const SESSION_HASH_PREFIX = 'session:';
// Primary relay session for (userId, channelId) — one upstream per channel
const CHANNEL_SESSION_PREFIX = 'channelSession:';
// ABR ladder: JSON map rendition -> sessionId for (userId, channelId)
const CHANNEL_ABR_PREFIX = 'channelAbr:';
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours

function v4Uuid() {
    return crypto.randomUUID();
}

function channelSessionKey(userId, channelId) {
    return CHANNEL_SESSION_PREFIX + userId + ':' + channelId;
}

function channelAbrKey(userId, channelId) {
    return CHANNEL_ABR_PREFIX + userId + ':' + channelId;
}

async function writeSessionHash(sessionId, fields) {
    if (!redis) return false;
    try {
        await redis.hset(SESSION_HASH_PREFIX + sessionId, fields);
        await redis.expire(SESSION_HASH_PREFIX + sessionId, SESSION_TTL_SECONDS);
        return true;
    } catch (e) {
        log.error('writeSessionHash error:', e.message);
        return false;
    }
}

async function addToSortedSet(userId, sessionId, score) {
    if (!redis) return false;
    try {
        // ioredis: zadd(key, score, member) — not node-redis object form
        await redis.zadd(SESSION_SORTED_SET_PREFIX + userId, score, sessionId);
        return true;
    } catch (e) {
        log.error('addToSortedSet error:', e.message);
        return false;
    }
}

async function removeFromSortedSet(userId, sessionId) {
    if (!redis) return;
    try {
        await redis.zrem(SESSION_SORTED_SET_PREFIX + userId, sessionId);
    } catch (e) {
        log.error('removeFromSortedSet error:', e.message);
    }
}

/**
 * Return existing active primary relay session for this channel, if any.
 * @returns {Promise<string|null>}
 */
async function findSharedRelaySession(userId, channelId) {
    if (!redis || !userId || !channelId) return null;
    try {
        const sid = await redis.get(channelSessionKey(userId, channelId));
        if (!sid) return null;
        const session = await getSession(sid);
        if (!session || session.status === 'countdown') {
            await redis.del(channelSessionKey(userId, channelId));
            return null;
        }
        if (String(session.channelId) !== String(channelId) || String(session.userId) !== String(userId)) {
            await redis.del(channelSessionKey(userId, channelId));
            return null;
        }
        return sid;
    } catch (e) {
        log.error('findSharedRelaySession error:', e.message);
        return null;
    }
}

/**
 * Index primary relay session so other devices reuse the same upstream.
 */
async function bindSharedRelaySession(userId, channelId, sessionId) {
    if (!redis || !userId || !channelId || !sessionId) return;
    try {
        await redis.set(
            channelSessionKey(userId, channelId),
            sessionId,
            'EX',
            SESSION_TTL_SECONDS
        );
    } catch (e) {
        log.error('bindSharedRelaySession error:', e.message);
    }
}

/**
 * Return ABR session map for this channel if every session still exists.
 * @returns {Promise<Record<string, string>|null>}
 */
async function findSharedAbrSessions(userId, channelId) {
    if (!redis || !userId || !channelId) return null;
    try {
        const raw = await redis.get(channelAbrKey(userId, channelId));
        if (!raw) return null;
        let map;
        try {
            map = JSON.parse(raw);
        } catch {
            await redis.del(channelAbrKey(userId, channelId));
            return null;
        }
        if (!map || typeof map !== 'object' || !map.source) {
            await redis.del(channelAbrKey(userId, channelId));
            return null;
        }
        for (const sid of Object.values(map)) {
            if (!sid || typeof sid !== 'string') {
                await redis.del(channelAbrKey(userId, channelId));
                return null;
            }
            const session = await getSession(sid);
            if (!session) {
                await redis.del(channelAbrKey(userId, channelId));
                return null;
            }
        }
        return map;
    } catch (e) {
        log.error('findSharedAbrSessions error:', e.message);
        return null;
    }
}

async function bindSharedAbrSessions(userId, channelId, sessionByRendition) {
    if (!redis || !userId || !channelId || !sessionByRendition || !sessionByRendition.source) return;
    try {
        await redis.set(
            channelAbrKey(userId, channelId),
            JSON.stringify(sessionByRendition),
            'EX',
            SESSION_TTL_SECONDS
        );
        // Primary channel index points at source so concurrency treats Auto as one pull
        await bindSharedRelaySession(userId, channelId, sessionByRendition.source);
    } catch (e) {
        log.error('bindSharedAbrSessions error:', e.message);
    }
}

/**
 * @param {string} userId
 * @param {string} channelId
 * @param {string} [rendition]
 * @param {{ countTowardLimit?: boolean }} [options]
 * @returns {Promise<string|null>}
 */
async function createSession(userId, channelId, rendition, options = {}) {
    if (!redis) return null;
    const sessionId = v4Uuid();
    const now = Date.now();
    const r = rendition || 'source';
    const countTowardLimit = options.countTowardLimit !== false;

    const wrote = await writeSessionHash(sessionId, {
        userId,
        channelId,
        startedAt: now,
        status: 'active',
        rendition: r,
    });
    if (!wrote) {
        log.error(`createSession: hash write failed for ${sessionId}`);
        return null;
    }

    if (countTowardLimit) {
        const indexed = await addToSortedSet(userId, sessionId, now);
        if (!indexed) {
            try {
                await redis.del(SESSION_HASH_PREFIX + sessionId);
            } catch (_) { /* best-effort rollback */ }
            log.error(`createSession: sorted-set write failed for ${sessionId}`);
            return null;
        }
        // Only the primary (slot-counting) session owns the shared channel index
        if (!rendition || rendition === 'source') {
            await bindSharedRelaySession(userId, channelId, sessionId);
        }
    }

    log.info(`Created session ${sessionId} for user ${userId}, channel ${channelId} (slot=${countTowardLimit})`);
    return sessionId;
}

async function reserveSessionSlot(userId, channelId, limit) {
    if (!redis) return null;

    // Reuse existing upstream for this channel — does not consume another slot
    const existing = await findSharedRelaySession(userId, channelId);
    if (existing) {
        await touchSession(existing, userId);
        log.info(`Reusing shared session ${existing} for user ${userId}, channel ${channelId}`);
        return existing;
    }

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
            'status', 'active',
            'rendition', 'source')
        redis.call('EXPIRE', KEYS[2], ARGV[5])
        redis.call('ZADD', KEYS[1], ARGV[4], ARGV[6])
        redis.call('SET', KEYS[3], ARGV[6], 'EX', ARGV[5])
        return 1`,
        3,
        SESSION_SORTED_SET_PREFIX + userId,
        SESSION_HASH_PREFIX + sessionId,
        channelSessionKey(userId, channelId),
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

async function touchSession(sessionId, userId) {
    if (!redis) return;
    try {
        await redis.zadd(SESSION_SORTED_SET_PREFIX + userId, Date.now(), sessionId);
        await writeSessionHash(sessionId, { lastActivityAt: Date.now() });
        // Refresh shared indexes TTLs when clients keep watching
        const session = await getSession(sessionId);
        if (session && session.channelId) {
            const key = channelSessionKey(userId, session.channelId);
            const bound = await redis.get(key);
            if (bound === sessionId) {
                await redis.expire(key, SESSION_TTL_SECONDS);
            }
            const abrKey = channelAbrKey(userId, session.channelId);
            if (await redis.exists(abrKey)) {
                await redis.expire(abrKey, SESSION_TTL_SECONDS);
            }
        }
    } catch (e) {
        log.error('touchSession error:', e.message);
    }
}

async function countActiveSessions(userId) {
    if (!redis) return 0;
    try {
        return await redis.zcard(SESSION_SORTED_SET_PREFIX + userId);
    } catch (e) {
        log.error('countActiveSessions error:', e.message);
        return 0;
    }
}

async function getLeastRecentlyActiveSession(userId, excludeSessionId) {
    if (!redis) return null;
    try {
        const members = await redis.zrange(SESSION_SORTED_SET_PREFIX + userId, 0, -1, 'WITHSCORES');
        if (!members || members.length === 0) return null;

        let leastSessionId = null;
        let leastScore = Infinity;

        for (let i = 0; i < members.length; i += 2) {
            const sid = members[i];
            const score = Number(members[i + 1]);
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

async function claimEviction(sessionId) {
    if (!redis) return false;
    return (await redis.hsetnx(SESSION_HASH_PREFIX + sessionId, 'evictionHandled', '1')) === 1;
}

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

async function destroySession(sessionId, userId) {
    if (!redis) return;
    try {
        const session = await getSession(sessionId);
        await removeFromSortedSet(userId, sessionId);
        await redis.del(SESSION_HASH_PREFIX + sessionId);

        if (session && session.channelId) {
            const ck = channelSessionKey(userId, session.channelId);
            const bound = await redis.get(ck);
            if (bound === sessionId) {
                await redis.del(ck);
            }
            // If this was an ABR source (or any ABR member), drop the whole ladder index
            const abrKey = channelAbrKey(userId, session.channelId);
            const abrRaw = await redis.get(abrKey);
            if (abrRaw) {
                try {
                    const map = JSON.parse(abrRaw);
                    if (map && Object.values(map).includes(sessionId)) {
                        await redis.del(abrKey);
                        // Clear primary index if it pointed at source we just killed
                        if (map.source === sessionId) {
                            await redis.del(ck);
                        }
                    }
                } catch (_) { /* ignore */ }
            }
        }

        log.info(`Destroyed session ${sessionId} for user ${userId}`);
    } catch (e) {
        log.error('destroySession error:', e.message);
    }
}

async function reapIdleSessions(idleTimeoutMs) {
    if (!redis) return 0;

    const now = Date.now();
    let cleanedCount = 0;

    const COUNTDOWN_HLS_TIME_MS = 2000;
    const COUNTDOWN_GRACE_MS = Math.max(4000, COUNTDOWN_HLS_TIME_MS * 2);

    try {
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${SESSION_SORTED_SET_PREFIX}*`, 'COUNT', 100);
            cursor = nextCursor;

            if (keys && keys.length) {
                for (const key of keys) {
                    const userId = key.substring(SESSION_SORTED_SET_PREFIX.length);
                    const members = await redis.zrange(SESSION_SORTED_SET_PREFIX + userId, 0, -1, 'WITHSCORES');

                    if (members && members.length > 0) {
                        for (let i = 0; i < members.length; i += 2) {
                            const sessionId = members[i];
                            const lastActivityAt = Number(members[i + 1]);

                            const session = await getSession(sessionId);
                            if (!session) {
                                await removeFromSortedSet(userId, sessionId);
                                continue;
                            }

                            const status = session.status;
                            let threshold;

                            if (status === 'countdown') {
                                threshold = now - COUNTDOWN_GRACE_MS;
                            } else {
                                threshold = now - idleTimeoutMs;
                            }

                            if (lastActivityAt < threshold) {
                                try {
                                    const { stopFfmpegForSession } = require('./streamRelay');
                                    await stopFfmpegForSession(sessionId);
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
    findSharedRelaySession,
    bindSharedRelaySession,
    findSharedAbrSessions,
    bindSharedAbrSessions,
};
