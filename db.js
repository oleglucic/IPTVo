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
    // Legacy aliases
    getMapping,
    saveMapping,
    adjustConfidence,
    getAllMappings
};