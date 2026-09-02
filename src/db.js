const { Pool } = require('pg');
const log = require('./logger').for('db');

const connectionString = process.env.DATABASE_URL;
const hasSupabase = !!connectionString; // kept name for compatibility with existing call-sites
let pool = null;

if (connectionString) {
    pool = new Pool({ connectionString });
    pool.on('error', (e) => log.error('Unexpected Postgres pool error:', e.message));
    log.info('Postgres pool initialised.');
} else {
    log.warn('DATABASE_URL not set - AI overrides and EPG history disabled.');
}

// -- getOverride --------------------------------------------------------------
/**
 * Fetch a single override mapping by raw channel name and country scope.
 * @param {string} rawName
 * @param {string} [scope='global']
 * @returns {Promise<{canonical_id: string, confidence: number}|null>}
 */
async function getOverride(rawName, scope = 'global') {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            'SELECT canonical_id, confidence FROM ai_overrides WHERE raw_name = $1 AND scope = $2',
            [rawName, scope]
        );
        if (!rows[0]) return null;
        return { canonical_id: rows[0].canonical_id, confidence: parseFloat(rows[0].confidence) };
    } catch (e) {
        log.error('getOverride:', e.message);
        return null;
    }
}

// -- setOverride ----------------------------------------------------------------
/**
 * Insert or update an override mapping, scoped to a country so the same raw
 * channel name can carry a different override per country instead of one
 * override applying to every country's copy of that name.
 * @param {string} rawName
 * @param {string} canonicalId
 * @param {number} [confidence=0.85]
 * @param {string} [scope='global']
 * @param {{query: Function}} [client] - Optional transaction client. When
 *   provided, a DB failure is logged AND re-thrown so the caller's enclosing
 *   transaction can roll back. Without a client the error is logged and
 *   swallowed (legacy callers keep the historical best-effort behaviour).
 */
async function setOverride(rawName, canonicalId, confidence = 0.85, scope = 'global', client = null) {
    const queryable = client || pool;
    if (!queryable) return;
    try {
        await queryable.query(
            `INSERT INTO ai_overrides (raw_name, scope, canonical_id, confidence, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (raw_name, scope)
             DO UPDATE SET canonical_id = $3, confidence = $4, updated_at = now()`,
            [rawName, scope, canonicalId, confidence]
        );
    } catch (e) {
        log.error('setOverride:', e.message);
        if (client) throw e;
    }
}

// -- incrementConfidence --------------------------------------------------------
/**
 * Increase a mapping's confidence score (capped at 0.99).
 * @param {string} rawName
 * @param {number} [delta=0.01]
 * @param {string} [scope='global']
 */
async function incrementConfidence(rawName, delta = 0.01, scope = 'global') {
    if (!pool) return;
    try {
        await pool.query(
            `UPDATE ai_overrides
             SET confidence = LEAST(confidence + $2, 0.99), updated_at = now()
             WHERE raw_name = $1 AND scope = $3`,
            [rawName, delta, scope]
        );
    } catch (e) {
        log.error('incrementConfidence:', e.message);
    }
}

// -- decrementConfidence ---------------------------------------------------------
/**
 * Decrease a mapping's confidence score (floored at 0.0).
 * @param {string} rawName
 * @param {number} [delta=0.1]
 * @param {string} [scope='global']
 */
async function decrementConfidence(rawName, delta = 0.1, scope = 'global') {
    if (!pool) return;
    try {
        await pool.query(
            `UPDATE ai_overrides
             SET confidence = GREATEST(confidence - $2, 0.0), updated_at = now()
             WHERE raw_name = $1 AND scope = $3`,
            [rawName, delta, scope]
        );
    } catch (e) {
        log.error('decrementConfidence:', e.message);
    }
}

// -- incrementUsage ---------------------------------------------------------------
/**
 * Bump usage_count for a raw_name+scope mapping.
 * @param {string} rawName
 * @param {string} [scope='global']
 */
async function incrementUsage(rawName, scope = 'global') {
    if (!pool) return;
    try {
        await pool.query(
            'UPDATE ai_overrides SET usage_count = usage_count + 1 WHERE raw_name = $1 AND scope = $2',
            [rawName, scope]
        );
    } catch (e) {
        log.error('incrementUsage:', e.message);
    }
}

// -- getAllOverrides ----------------------------------------------------------------
/**
 * Fetch all override rows (used by the dashboard).
 * @returns {Promise<Array>}
 */
async function getAllOverrides() {
    if (!pool) return [];
    try {
        const { rows } = await pool.query(
            'SELECT * FROM ai_overrides ORDER BY usage_count DESC'
        );
        return rows || [];
    } catch (e) {
        log.error('getAllOverrides:', e.message);
        return [];
    }
}

// -- Community channel matching --------------------------------------------------
// Lets a user manually match a channel iptv-org has no entry for (so nothing
// in the normal matching pipeline can find it) to a shared, named,
// alias-bearing "community_channels" entry. A single vote takes effect
// immediately for everyone sharing that raw playlist name (an explicit user
// action is trusted more than an unmatched channel sitting there broken),
// and once enough DISTINCT users (by config_key, not just resubmission
// count) independently agree, confidence is raised and the raw name is
// folded into the entry's aliases for future reference. The live, in-effect
// mapping the parser actually reads is still ai_overrides — these two
// tables are the curation/provenance layer feeding it, not a second
// matching path the parser needs to know about.
const COMMUNITY_VOTE_CONFIDENCE = { 1: 0.70, 2: 0.80 }; // 3+ votes -> 0.95 (see below)
const COMMUNITY_CONSENSUS_THRESHOLD = 3;

/**
 * Searches community_channels by display name or a known alias.
 * @param {string} query - Search text.
 * @param {string} [scope] - Optional country to prioritize/filter by.
 * @returns {Promise<Array>} Matching rows, best (country-matching) first.
 */
async function searchCommunityChannels(query, scope) {
    if (!pool || !query) return [];
    try {
        const safeQuery = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        const { rows } = await pool.query(
            `SELECT id, canonical_id, display_name, country, categories, aliases
             FROM community_channels
             WHERE display_name ILIKE '%' || $1 || '%' ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE '%' || $2 || '%' ESCAPE '\\')
             ORDER BY (country = $3) DESC, display_name ASC
             LIMIT 25`,
            [safeQuery, safeQuery, scope || 'global']
        );
        return rows || [];
    } catch (e) {
        log.error('searchCommunityChannels:', e.message);
        return [];
    }
}

/**
 * Creates a new community_channels entry, or returns the existing one if
 * canonical_id already exists (idempotent — a user creating "the same"
 * entry twice shouldn't duplicate it).
 * @param {{canonicalId: string, displayName: string, country?: string, categories?: string[]}} params
 * @returns {Promise<Object|null>} The created (or existing) row.
 */
async function createCommunityChannel({ canonicalId, displayName, country = 'global', categories = [] }) {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            `INSERT INTO community_channels (canonical_id, display_name, country, categories)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (canonical_id) DO UPDATE SET updated_at = now()
             RETURNING id, canonical_id, display_name, country, categories, aliases`,
            [canonicalId, displayName, country, categories]
        );
        return rows[0] || null;
    } catch (e) {
log.error('createCommunityChannel:', e.message);
        return null;
    }
}

/**
 * Casts (or updates) one user's vote matching a raw channel name to a
 * community_channels entry, then immediately promotes the current
 * leading candidate for that (raw_name, scope) into ai_overrides so the
 * match takes effect on the next catalog reload — for the voter right away,
 * and for anyone else sharing that raw playlist name too. Confidence rises
 * with distinct-voter consensus; at the threshold, the raw name is folded
 * into the entry's aliases.
 * @param {{communityChannelId: number, rawName: string, scope: string, configKey: string}} params
 * @returns {Promise<{canonicalId: string, voteCount: number, promoted: boolean}|null>}
 */
async function voteCommunityChannel({ communityChannelId, rawName, scope = 'global', configKey }) {
    if (!pool || !communityChannelId || !rawName || !configKey) return null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Serialize votes for the same raw name and scope, including the first
        // vote where no row exists yet for a row-level lock to acquire.
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`${rawName}\u0001${scope}`]
        );
        await client.query(
            `INSERT INTO community_channel_votes (community_channel_id, raw_name, scope, config_key)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (raw_name, scope, config_key)
             DO UPDATE SET community_channel_id = $1, created_at = now()`,
            [communityChannelId, rawName, scope, configKey]
        );

        const { rows: leaderRows } = await client.query(
            `SELECT community_channel_id, COUNT(*)::int AS votes
             FROM community_channel_votes
             WHERE raw_name = $1 AND scope = $2
             GROUP BY community_channel_id
             ORDER BY votes DESC, community_channel_id ASC
             LIMIT 1`,
            [rawName, scope]
        );
        const leader = leaderRows[0];
        if (!leader) throw new Error('Community vote leader could not be resolved');

        const { rows: chRows } = await client.query(
            'SELECT canonical_id FROM community_channels WHERE id = $1 FOR UPDATE',
            [leader.community_channel_id]
        );
        const canonicalId = chRows[0] && chRows[0].canonical_id;
        if (!canonicalId) throw new Error('Community vote leader channel could not be resolved');

        const promoted = leader.votes >= COMMUNITY_CONSENSUS_THRESHOLD;
        const confidence = promoted ? 0.95 : (COMMUNITY_VOTE_CONFIDENCE[leader.votes] || 0.70);
        await setOverride(rawName, canonicalId, confidence, scope, client);

        if (promoted) {
            await client.query(
                `UPDATE community_channels
                 SET aliases = array_append(aliases, $1), updated_at = now()
                 WHERE id = $2 AND NOT ($1 = ANY(aliases))`,
                [rawName, leader.community_channel_id]
            );
        }

        await client.query('COMMIT');
        return { canonicalId, voteCount: leader.votes, promoted };
    } catch (e) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            log.error('voteCommunityChannel rollback:', rollbackError.message);
        }
        log.error('voteCommunityChannel:', e.message);
        throw e;
    } finally {
        client.release();
    }
}


const getMapping  = getOverride;
const saveMapping = setOverride;
const adjustConfidence = async (rawName, isSuccess, scope = 'global') => {
    if (isSuccess) return incrementConfidence(rawName, undefined, scope);
    return decrementConfidence(rawName, undefined, scope);
};
const getAllMappings = getAllOverrides;

// -- saveEpgSnapshot ------------------------------------------------------------
/**
 * Persist a batch of EPG programs for a channel, so we build our own
 * rolling history over time (XMLTV feeds are forward-looking only).
 * @param {string} channelKey
 * @param {Array<{title: string, desc: string, start: number, stop: number}>} programs
 */
async function saveEpgSnapshot(channelKey, programs) {
    if (!pool || !programs || programs.length === 0) return;
    try {
        const client = await pool.connect();
        try {
            for (const p of programs) {
                await client.query(
                    `INSERT INTO epg_history (channel_key, title, description, start_time, stop_time)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (channel_key, start_time) DO NOTHING`,
                    [channelKey, p.title || null, p.desc || null, p.start, p.stop]
                );
            }
        } finally {
            client.release();
        }
    } catch (e) {
        log.error('saveEpgSnapshot:', e.message);
    }
}

// -- getEpgHistory ----------------------------------------------------------------
/**
 * Retrieves recorded programs for a channel within a lookback period.
 * @param {string} channelKey - The channel identifier.
 * @param {number} [hoursBack=48] - The number of hours to look back.
 * @return {Array} Programs ending within the lookback period, or an empty array if unavailable.
 */
async function getEpgHistory(channelKey, hoursBack = 48) {
    if (!pool) return [];
    try {
        const since = Date.now() - (hoursBack * 60 * 60 * 1000);
        const { rows } = await pool.query(
            `SELECT title, description, start_time, stop_time FROM epg_history
             WHERE channel_key = $1 AND stop_time >= $2 AND stop_time <= $3
             ORDER BY start_time DESC`,
            [channelKey, since, Date.now()]
        );
        return rows || [];
    } catch (e) {
        log.error('getEpgHistory:', e.message);
        return [];
    }
}

// -- pruneEpgHistory ------------------------------------------------------------
/**
 * Removes EPG history records older than the specified retention window.
 * @param {number} [maxAgeMs=7*24*60*60*1000] - Maximum age of records to retain, in milliseconds.
 * @return {Promise<number>} The number of deleted records, or `0` if the database is unavailable or the operation fails.
 */
async function pruneEpgHistory(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    if (!pool) return 0;
    const cutoff = Date.now() - maxAgeMs;
    try {
        const res = await pool.query('DELETE FROM epg_history WHERE start_time < $1', [cutoff]);
        if (res && res.rowCount > 0) {
            log.info(`Deleted ${res.rowCount} old rows (cutoff=${new Date(cutoff).toISOString()})`);
        }
        return res ? res.rowCount : 0;
    } catch (e) {
        log.error('pruneEpgHistory:', e.message);
        return 0;
    }
}

// -- epg_programs / epg_sources (central multi-source EPG) --------------------
// epg_programs is the server-side central EPG store merged from multiple sources
// (see epgHub.js); user-facing requests read it via a Redis cache (redisCache.js).
// epg_sources is the registry of enabled providers, extensible by users.

/**
 * Stores a channel's programs for a provider in the central EPG store.
 * @param {string} channelKey - The canonical channel identifier.
 * @param {string} source - The provider name.
 * @param {Array<{title: string, desc?: string, start: number, stop: number}>} programs - Programs to create or update.
 */
async function saveEpgPrograms(channelKey, source, programs) {
    if (!pool || !programs || programs.length === 0) return;
    // Accumulate rows and batch in ONE client/transaction (a fresh connect per
    // row was very slow for multi-channel feeds with thousands of programmes).
    const params = [];
    const values = [];
    let idx = 1;
    const seenStarts = new Set(); // (channel,source,start_time) unique in one batch (ON CONFLICT limit)
    for (const p of programs) {
        const startK = `${channelKey} ${source} ${p.start}`;
        if (seenStarts.has(startK)) continue;
        seenStarts.add(startK);
        values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
        params.push(channelKey, source, p.title || 'Unknown', p.desc || null, p.start, p.stop);
    }
    if (values.length === 0) return;
    try {
        const client = await pool.connect();
        try {
            await client.query(
                `INSERT INTO epg_programs (channel_key, source, title, description, start_time, stop_time)
                 VALUES ${values.join(',')}
                 ON CONFLICT (channel_key, source, start_time)
                 DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, stop_time = EXCLUDED.stop_time`,
                params
            );
        } finally {
            client.release();
        }
    } catch (e) {
        log.error('saveEpgPrograms:', e.message);
    }
}

/**
 * Retrieves a channel's programs from the central EPG store within a time range.
 * @param {string} channelKey - The canonical channel identifier.
 * @param {number} from - The start of the time range as an epoch timestamp in milliseconds.
 * @param {number} to - The end of the time range as an epoch timestamp in milliseconds.
 * @return {Array<Object>} Programs ordered by start time, with one program selected for each start time.
 */
async function getEpgPrograms(channelKey, from, to) {
    if (!pool) return [];
    try {
        const { rows } = await pool.query(
            `SELECT DISTINCT ON (start_time) title, description, start_time, stop_time
             FROM epg_programs
             WHERE channel_key = $1 AND start_time <= $3 AND stop_time >= $2
             ORDER BY start_time ASC`,
            [channelKey, from || 0, to || Date.now() + 14 * 24 * 60 * 60 * 1000]
        );
        return rows || [];
    } catch (e) {
        log.error('getEpgPrograms:', e.message);
        return [];
    }
}

/**
 * Fetches central EPG programs for many channels in one query, grouped by channel.
 * @param {string[]} channelKeys - The channel keys to fetch programs for.
 * @param {number} from - The start of the time range as an epoch timestamp in milliseconds.
 * @param {number} to - The end of the time range as an epoch timestamp in milliseconds.
 * @return {Map<string, Array<Object>>} A map of channel key to its ordered programs (program selection per start time).
 */
async function getEpgProgramsMany(channelKeys, from, to) {
    const out = new Map();
    if (!pool || !channelKeys || channelKeys.length === 0) return out;
    try {
        const { rows } = await pool.query(
            `SELECT DISTINCT ON (channel_key, start_time) channel_key, title, description, start_time, stop_time
             FROM epg_programs
             WHERE channel_key = ANY($1) AND start_time <= $3 AND stop_time >= $2
             ORDER BY channel_key, start_time ASC`,
            [channelKeys, from || 0, to || Date.now() + 14 * 24 * 60 * 60 * 1000]
        );
        for (const r of rows) {
            if (!out.has(r.channel_key)) out.set(r.channel_key, []);
            out.get(r.channel_key).push({ title: r.title, desc: r.description, start: Number(r.start_time), stop: Number(r.stop_time) });
        }
        return out;
    } catch (e) {
        log.error('getEpgProgramsMany:', e.message);
        return out;
    }
}

/** List all registered EPG sources (registry). */
async function listEpgSources() {
    if (!pool) return [];
    try {
        const { rows } = await pool.query('SELECT * FROM epg_sources');
        return rows || [];
    } catch (e) {
        log.error('listEpgSources:', e.message);
        return [];
    }
}

/** Update a source's fetch/success/error tracking. */
async function setEpgSourceStatus(source, { last_fetch, last_success, error_count } = {}) {
    if (!pool) return;
    try {
        await pool.query(
            `UPDATE epg_sources SET
                last_fetch = COALESCE($2, last_fetch),
                last_success = COALESCE($3, last_success),
                error_count = COALESCE($4, error_count)
             WHERE source = $1`,
            [source, last_fetch || 0, last_success || 0, error_count == null ? null : error_count]
        );
    } catch (e) {
        log.error('setEpgSourceStatus:', e.message);
    }
}

/**
 * Creates or updates an EPG source registry entry.
 * @param {Object} src - EPG source configuration, including its identifier and optional status, type, URL, region, and notes.
 */
async function upsertEpgSource(src) {
    if (!pool) return;
    try {
        // On conflict, refresh metadata but preserve the stored `enabled` flag so
        // a source a user disabled in the registry is not re-enabled by seeding.
        await pool.query(
            `INSERT INTO epg_sources (source, enabled, kind, url, region, notes)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (source) DO UPDATE SET
                kind = EXCLUDED.kind,
                url = EXCLUDED.url, region = EXCLUDED.region, notes = EXCLUDED.notes`,
            [src.source, src.enabled !== false, src.kind || 'general', src.url || '', src.region || 'global', src.notes || null]
        );
    } catch (e) {
        log.error('upsertEpgSource:', e.message);
    }
}

/**
 * Deletes central EPG records older than the retention window.
 * @param {number} [maxAgeMs=1209600000] - Retention window in milliseconds.
 * @returns {number} The number of deleted records.
 */
async function pruneEpgPrograms(maxAgeMs = 14 * 24 * 60 * 60 * 1000) {
    if (!pool) return 0;
    const cutoff = Date.now() - maxAgeMs;
    try {
        const res = await pool.query('DELETE FROM epg_programs WHERE start_time < $1', [cutoff]);
        return res ? res.rowCount : 0;
    } catch (e) {
        log.error('pruneEpgPrograms:', e.message);
        return 0;
    }
}

// -- User Management (Encrypted Config Storage) -------------------------------

/**
 * Create a new user with encrypted config
 * @param {string} username - Username
 * @param {string} passwordHash - Bcrypt password hash
 * @param {object} config - Config object to encrypt
 * @param {string} encryptionKey - Encryption key (from env)
 * @returns {Promise<{user_id: string}|null>}
 */
async function createUser(username, passwordHash, config, encryptionKey) {
    if (!pool) return null;
    try {
        const { encryptConfig } = require('./cryptoUtils');
        const { encryptedConfig, iv, salt } = await encryptConfig(config, encryptionKey);

        const { rows } = await pool.query(
            `INSERT INTO users (username, password_hash, encrypted_config, config_iv, config_salt)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING user_id`,
            [username, passwordHash, encryptedConfig, iv, salt]
        );
        return rows[0] || null;
    } catch (e) {
        log.error('createUser:', e.message);
        return null;
    }
}

/**
 * Get user by username
 * @param {string} username - Username
 * @returns {Promise<object|null>}
 */
async function getUserByUsername(username) {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            'SELECT user_id, username, password_hash, encrypted_config, config_iv, config_salt, created_at, updated_at FROM users WHERE username = $1',
            [username]
        );
        return rows[0] || null;
    } catch (e) {
        log.error('getUserByUsername:', e.message);
        return null;
    }
}

/**
 * Retrieves a user by UUID.
 * @param {string} userId - The user's UUID.
 * @returns {Promise<object|null>} The matching user record, or `null` if the UUID is invalid, the user is not found, or the database is unavailable.
 */
async function getUserById(userId) {
    if (!pool) return null;
    // A legacy base64 config key can reach this erroneously via `_userId`;
    // Postgres rejects non-UUID input as noisy ERROR spam on every request.
    // Short-circuit before the query — it is never a real user.
    if (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
        return null;
    }
    try {
        const { rows } = await pool.query(
            'SELECT user_id, username, password_hash, encrypted_config, config_iv, config_salt, created_at, updated_at FROM users WHERE user_id = $1',
            [userId]
        );
        return rows[0] || null;
    } catch (e) {
        log.error('getUserById:', e.message);
        return null;
    }
}

/**
 * Sensitive credentials the server never returns to the client. When a save
 * omits one (blank or '[REDACTED]'), the stored value is preserved instead of
 * being overwritten with an empty string.
 */
const CONFIG_SENSITIVE_FIELDS = ['password', 'openrouterKey'];

/**
 * Update user's encrypted config, preserving stored credentials when the incoming
 * config omits them.
 *
 * The read-merge-write happens inside a single transaction with a row lock
 * (SELECT ... FOR UPDATE) so concurrent saves cannot overwrite each other's
 * preserved secrets: a password update and an OpenRouter key update racing each
 * other each begin from the latest committed config rather than a stale snapshot.
 *
 * @param {string} userId - User UUID
 * @param {object} config - Config object to encrypt
 * @param {string} encryptionKey - Encryption key (from env)
 * @returns {Promise<object|false>} The merged config actually persisted, or `false` on failure
 */
async function updateUserConfig(userId, config, encryptionKey) {
    if (!pool) return false;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'SELECT encrypted_config, config_iv, config_salt FROM users WHERE user_id = $1 FOR UPDATE',
            [userId]
        );
        const { decryptConfig, encryptConfig } = require('./cryptoUtils');
        const row = rows[0];
        let merged = config;
        if (row && row.encrypted_config && row.config_iv && row.config_salt) {
            const existing = await decryptConfig(row.encrypted_config, row.config_iv, row.config_salt, encryptionKey) || {};
            merged = { ...config };
            for (const field of CONFIG_SENSITIVE_FIELDS) {
                const incoming = config[field];
                const omitted = incoming === undefined || incoming === '' || incoming === '[REDACTED]';
                if (omitted && existing[field]) merged[field] = existing[field];
            }
        }

        const { encryptedConfig, iv, salt } = await encryptConfig(merged, encryptionKey);
        await client.query(
            `UPDATE users
             SET encrypted_config = $1, config_iv = $2, config_salt = $3, updated_at = now()
             WHERE user_id = $4`,
            [encryptedConfig, iv, salt, userId]
        );
        await client.query('COMMIT');
        return merged;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection may be broken */ }
        log.error('updateUserConfig:', e.message);
        return false;
    } finally {
        client.release();
    }
}

// -- Logo URL Tracking ----------------------------------------------------------
/**
 * Persistent logo URL storage - survives Redis restarts, no expiry.
 * Only refreshed when URL actually changes (detected during parsing).
 * @param {string} channelId - The channel ID
 * @returns {Promise<{url: string, source: string, updated_at: Date}|null>}
 */
async function getLogoUrl(channelId) {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            'SELECT url, source, updated_at FROM logo_urls WHERE channel_id = $1',
            [channelId]
        );
        return rows[0] || null;
    } catch (e) {
        log.error('getLogoUrl:', e.message);
        return null;
    }
}

/**
 * Store/update a channel's logo URL. Only overwrites if URL actually changed.
 * @param {string} channelId - The channel ID
 * @param {string} logoUrl - The logo URL
 * @param {string} source - Source: 'iptv-org', 'playlist', 'fallback'
 */
async function setLogoUrl(channelId, logoUrl, source = 'unknown') {
    if (!pool) return;
    try {
        await pool.query(
            `INSERT INTO logo_urls (channel_id, url, source, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (channel_id)
             DO UPDATE SET url = $2, source = $3, updated_at = now()
             WHERE logo_urls.url != $2`, // Only update if URL actually changed
            [channelId, logoUrl, source]
        );
    } catch (e) {
        log.error('setLogoUrl:', e.message);
    }
}

module.exports = {
    // Primary API
    // Exported so dbInit.js can check that the pool exists before running
    // schema init. Without this export, require('./db').pool is undefined even
    // when DATABASE_URL is set, and init + every query silently no-ops.
    pool,
    getOverride,
    setOverride,
    incrementConfidence,
    decrementConfidence,
    incrementUsage,
    getAllOverrides,
    // Community channel matching
    searchCommunityChannels,
    createCommunityChannel,
    voteCommunityChannel,
    hasSupabase,
    saveEpgSnapshot,
    getEpgHistory,
    pruneEpgHistory,
    // Central multi-source EPG (epg_programs / epg_sources)
    saveEpgPrograms,
    getEpgPrograms,
    getEpgProgramsMany,
    listEpgSources,
    setEpgSourceStatus,
    upsertEpgSource,
    pruneEpgPrograms,
    // Logo URL tracking (persistent, no expiry)
    getLogoUrl,
    setLogoUrl,
    // User management (encrypted config storage)
    createUser,
    getUserByUsername,
    getUserById,
    updateUserConfig,
    // Legacy aliases
    getMapping,
    saveMapping,
    adjustConfidence,
    getAllMappings
};
