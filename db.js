const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const hasSupabase = !!connectionString; // kept name for compatibility with existing call-sites
let pool = null;

if (connectionString) {
    pool = new Pool({ connectionString });
    pool.on('error', (e) => console.error('[DB Error] Unexpected Postgres pool error:', e.message));
    console.log('[DB] Postgres pool initialised.');
} else {
    console.warn('[DB] DATABASE_URL not set - AI overrides and EPG history disabled.');
}

// -- getOverride --------------------------------------------------------------
/**
 * Fetch a single override mapping by raw channel name.
 * @param {string} rawName
 * @returns {Promise<{canonical_id: string, confidence: number}|null>}
 */
async function getOverride(rawName) {
    if (!pool) return null;
    try {
        const { rows } = await pool.query(
            'SELECT canonical_id, confidence FROM ai_overrides WHERE raw_name = $1',
            [rawName]
        );
        if (!rows[0]) return null;
        return { canonical_id: rows[0].canonical_id, confidence: parseFloat(rows[0].confidence) };
    } catch (e) {
        console.error('[DB Error] getOverride:', e.message);
        return null;
    }
}

// -- setOverride ----------------------------------------------------------------
/**
 * Insert or update an override mapping.
 * @param {string} rawName
 * @param {string} canonicalId
 * @param {number} [confidence=0.85]
 */
async function setOverride(rawName, canonicalId, confidence = 0.85) {
    if (!pool) return;
    try {
        await pool.query(
            `INSERT INTO ai_overrides (raw_name, canonical_id, confidence, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (raw_name)
             DO UPDATE SET canonical_id = $2, confidence = $3, updated_at = now()`,
            [rawName, canonicalId, confidence]
        );
    } catch (e) {
        console.error('[DB Error] setOverride:', e.message);
    }
}

// -- incrementConfidence --------------------------------------------------------
/**
 * Increase a mapping's confidence score (capped at 0.99).
 * @param {string} rawName
 * @param {number} [delta=0.01]
 */
async function incrementConfidence(rawName, delta = 0.01) {
    if (!pool) return;
    try {
        await pool.query(
            `UPDATE ai_overrides
             SET confidence = LEAST(confidence + $2, 0.99), updated_at = now()
             WHERE raw_name = $1`,
            [rawName, delta]
        );
    } catch (e) {
        console.error('[DB Error] incrementConfidence:', e.message);
    }
}

// -- decrementConfidence ---------------------------------------------------------
/**
 * Decrease a mapping's confidence score (floored at 0.0).
 * @param {string} rawName
 * @param {number} [delta=0.1]
 */
async function decrementConfidence(rawName, delta = 0.1) {
    if (!pool) return;
    try {
        await pool.query(
            `UPDATE ai_overrides
             SET confidence = GREATEST(confidence - $2, 0.0), updated_at = now()
             WHERE raw_name = $1`,
            [rawName, delta]
        );
    } catch (e) {
        console.error('[DB Error] decrementConfidence:', e.message);
    }
}

// -- incrementUsage ---------------------------------------------------------------
/**
 * Bump usage_count for a raw_name mapping.
 * @param {string} rawName
 */
async function incrementUsage(rawName) {
    if (!pool) return;
    try {
        await pool.query(
            'UPDATE ai_overrides SET usage_count = usage_count + 1 WHERE raw_name = $1',
            [rawName]
        );
    } catch (e) {
        console.error('[DB Error] incrementUsage:', e.message);
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
        console.error('[DB Error] getAllOverrides:', e.message);
        return [];
    }
}

// -- Legacy aliases kept for any remaining call-sites ----------------------------
const getMapping  = getOverride;
const saveMapping = setOverride;
const adjustConfidence = async (rawName, isSuccess) => {
    if (isSuccess) return incrementConfidence(rawName);
    return decrementConfidence(rawName);
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
        console.error('[DB Error] saveEpgSnapshot:', e.message);
    }
}

// -- getEpgHistory ----------------------------------------------------------------
/**
 * Fetch a channel's recorded program history for the last N hours.
 * @param {string} channelKey
 * @param {number} [hoursBack=48]
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
        console.error('[DB Error] getEpgHistory:', e.message);
        return [];
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
        console.error('[DB Error] createUser:', e.message);
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
        console.error('[DB Error] getUserByUsername:', e.message);
        return null;
    }
}

/**
 * Get user by user_id
 * @param {string} userId - User UUID
 * @returns {Promise<object|null>}
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
        console.error('[DB Error] getUserById:', e.message);
        return null;
    }
}

/**
 * Update user's encrypted config
 * @param {string} userId - User UUID
 * @param {object} config - Config object to encrypt
 * @param {string} encryptionKey - Encryption key (from env)
 * @returns {Promise<boolean>}
 */
async function updateUserConfig(userId, config, encryptionKey) {
    if (!pool) return false;
    try {
        const { encryptConfig } = require('./cryptoUtils');
        const { encryptedConfig, iv, salt } = await encryptConfig(config, encryptionKey);

        await pool.query(
            `UPDATE users
             SET encrypted_config = $1, config_iv = $2, config_salt = $3, updated_at = now()
             WHERE user_id = $4`,
            [encryptedConfig, iv, salt, userId]
        );
        return true;
    } catch (e) {
        console.error('[DB Error] updateUserConfig:', e.message);
        return false;
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
        console.error('[DB Error] getLogoUrl:', e.message);
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
        console.error('[DB Error] setLogoUrl:', e.message);
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
    hasSupabase,
    saveEpgSnapshot,
    getEpgHistory,
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