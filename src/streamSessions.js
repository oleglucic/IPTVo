// streamSessions.js
// Redis-backed session tracking for concurrency-limited streaming proxy.
//
// Provider concurrency counts *distinct channels* (upstream pulls), not devices.
// ABR ladder sessions share one channel index; secondary rungs are not concurrency
// slots and must not be idle-reaped while the ladder is still in use.

const crypto = require('crypto');
const { hasRedis, redisClient } = require('./redisCache');
const log = require('./logger').for('streamSessions');

const redis = hasRedis ? redisClient : null;
if (!redis) {
    log.warn('Redis not available for session tracking - concurrency limiting disabled.');
}

const SESSION_SORTED_SET_PREFIX = 'sessions:';
const SESSION_HASH_PREFIX = 'session:';
const CHANNEL_SESSION_PREFIX = 'channelSession:';
const CHANNEL_ABR_PREFIX = 'channelAbr:';
const SESSION_TTL_SECONDS = 4 * 60 * 60;

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

async function bindSharedRelaySession(userId, channelId, sessionId) {
    if (!redis || !userId || !channelId || !sessionId) return;
    try {
        await redis.set(channelSessionKey(userId, channelId), sessionId, 'EX', SESSION_TTL_SECONDS);
    } catch (e) {
        log.error('bindSharedRelaySession error:', e.message);
    }
}

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
        await bindSharedRelaySession(userId, channelId, sessionByRendition.source);
        const now = String(Date.now());
        for (const [rendition, sid] of Object.entries(sessionByRendition)) {
            if (!sid) continue;
            await writeSessionHash(sid, {
                abrChannelId: String(channelId),
                abrRole: rendition === 'source' ? 'source' : 'rendition',
                lastActivityAt: now,
            });
        }
    } catch (e) {
        log.error('bindSharedAbrSessions error:', e.message);
    }
}

/**
 * Refresh activity for every session in an ABR ladder (keeps unused rungs alive
 * while any client is watching the channel).
 */
async function touchAbrLadder(userId, channelId) {
    if (!redis || !userId || !channelId) return;
    try {
        const raw = await redis.get(channelAbrKey(userId, channelId));
        if (!raw) return;
        let map;
        try {
            map = JSON.parse(raw);
        } catch {
            return;
        }
        const now = String(Date.now());
        const score = Date.now();
        for (const sid of Object.values(map || {})) {
            if (!sid) continue;
            await writeSessionHash(sid, { lastActivityAt: now });
        }
        if (map.source) {
            const src = await getSession(map.source);
            if (src && src.countsTowardLimit === '1') {
                await redis.zadd(SESSION_SORTED_SET_PREFIX + userId, score, map.source);
            }
        }
        await redis.expire(channelAbrKey(userId, channelId), SESSION_TTL_SECONDS);
        await redis.expire(channelSessionKey(userId, channelId), SESSION_TTL_SECONDS);
    } catch (e) {
        log.error('touchAbrLadder error:', e.message);
    }
}

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
        countsTowardLimit: countTowardLimit ? '1' : '0',
        lastActivityAt: String(now),
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
        if (!rendition || rendition === 'source') {
            await bindSharedRelaySession(userId, channelId, sessionId);
        }
    }

    log.info(`Created session ${sessionId} for user ${userId}, channel ${channelId} (slot=${countTowardLimit})`);
    return sessionId;
}

async function reserveSessionSlot(userId, channelId, limit) {
    if (!redis) return null;

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
            'rendition', 'source',
            'countsTowardLimit', '1',
            'lastActivityAt', ARGV[4])
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
        const session = await getSession(sessionId);
        if (!session) return;

        const now = Date.now();
        await writeSessionHash(sessionId, { lastActivityAt: String(now) });

        const abrChannelId = session.abrChannelId || session.channelId;
        if (abrChannelId) {
            const abrRaw = await redis.get(channelAbrKey(userId, abrChannelId));
            if (abrRaw) {
                await touchAbrLadder(userId, abrChannelId);
                return;
            }
        }

        if (session.countsTowardLimit === '1') {
            await redis.zadd(SESSION_SORTED_SET_PREFIX + userId, now, sessionId);
            if (session.channelId) {
                const key = channelSessionKey(userId, session.channelId);
                const bound = await redis.get(key);
                if (bound === sessionId) {
                    await redis.expire(key, SESSION_TTL_SECONDS);
                }
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

            const abrKey = channelAbrKey(userId, session.channelId);
            const abrRaw = await redis.get(abrKey);
            if (abrRaw) {
                try {
                    const map = JSON.parse(abrRaw);
                    if (map && map.source === sessionId) {
                        await redis.del(abrKey);
                        for (const [role, sid] of Object.entries(map)) {
                            if (!sid || sid === sessionId) continue;
                            await removeFromSortedSet(userId, sid);
                            await redis.del(SESSION_HASH_PREFIX + sid);
                            try {
                                const { stopFfmpegForSession } = require('./streamRelay');
                                await stopFfmpegForSession(sid);
                            } catch (_) { /* ignore */ }
                        }
                    } else if (map && Object.values(map).includes(sessionId)) {
                        const next = { ...map };
                        for (const [k, v] of Object.entries(next)) {
                            if (v === sessionId) delete next[k];
                        }
                        if (next.source) {
                            await redis.set(abrKey, JSON.stringify(next), 'EX', SESSION_TTL_SECONDS);
                        } else {
                            await redis.del(abrKey);
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
                    if (!members || members.length === 0) continue;

                    for (let i = 0; i < members.length; i += 2) {
                        const sessionId = members[i];
                        const lastActivityAt = Number(members[i + 1]);
                        const session = await getSession(sessionId);
                        if (!session) {
                            await removeFromSortedSet(userId, sessionId);
                            continue;
                        }
                        if (session.abrRole === 'rendition' || session.countsTowardLimit === '0') {
                            await removeFromSortedSet(userId, sessionId);
                            continue;
                        }
                        const status = session.status;
                        const threshold = status === 'countdown'
                            ? now - COUNTDOWN_GRACE_MS
                            : now - idleTimeoutMs;
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
        } while (cursor !== '0');

        cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${CHANNEL_ABR_PREFIX}*`, 'COUNT', 50);
            cursor = nextCursor;
            if (!keys || !keys.length) continue;

            for (const key of keys) {
                const rest = key.substring(CHANNEL_ABR_PREFIX.length);
                const uuidMatch = rest.match(
                    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/i
                );
                if (!uuidMatch) continue;
                const userId = uuidMatch[1];
                const channelId = uuidMatch[2];

                const raw = await redis.get(key);
                if (!raw) continue;
                let map;
                try {
                    map = JSON.parse(raw);
                } catch {
                    await redis.del(key);
                    continue;
                }
                if (!map || !map.source) {
                    await redis.del(key);
                    continue;
                }

                const source = await getSession(map.source);
                if (!source) {
                    for (const sid of Object.values(map)) {
                        if (sid) {
                            try {
                                const { stopFfmpegForSession } = require('./streamRelay');
                                await stopFfmpegForSession(sid);
                            } catch (_) { /* ignore */ }
                            await removeFromSortedSet(userId, sid);
                            await redis.del(SESSION_HASH_PREFIX + sid);
                        }
                    }
                    await redis.del(key);
                    await redis.del(channelSessionKey(userId, channelId));
                    cleanedCount++;
                    continue;
                }

                const last = Number(source.lastActivityAt || source.startedAt || 0);
                if (last && last < now - idleTimeoutMs) {
                    log.info(`Reaping idle ABR ladder user=${userId} channel=${channelId}`);
                    for (const sid of Object.values(map)) {
                        if (!sid) continue;
                        try {
                            const { stopFfmpegForSession } = require('./streamRelay');
                            await stopFfmpegForSession(sid);
                        } catch (_) { /* ignore */ }
                        await removeFromSortedSet(userId, sid);
                        await redis.del(SESSION_HASH_PREFIX + sid);
                        cleanedCount++;
                    }
                    await redis.del(key);
                    await redis.del(channelSessionKey(userId, channelId));
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
    touchAbrLadder,
};
