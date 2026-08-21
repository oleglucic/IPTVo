// dbInit.js
// Run database schema initialization on startup. Safe to run multiple times.

const pool = require('./db').pool;

/**
 * Initializes the PostgreSQL schema and supporting indexes when a database connection is available.
 */
async function initSchema() {
    if (!pool) {
        console.log('[DB Init] No DATABASE_URL - skipping schema init');
        return;
    }

    const statements = [
        // users (encrypted config storage with password auth)
        `CREATE TABLE IF NOT EXISTS users (
            user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            username VARCHAR(100) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            encrypted_config TEXT, -- AES-GCM encrypted config JSON
            config_iv TEXT,        -- IV for AES-GCM (base64)
            config_salt TEXT,      -- Salt for key derivation (base64)
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,

        // ai_overrides (created in earlier versions)
        `CREATE TABLE IF NOT EXISTS ai_overrides (
            raw_name VARCHAR(500) PRIMARY KEY,
            canonical_id VARCHAR(255) NOT NULL,
            confidence DECIMAL(3,2) NOT NULL DEFAULT 0.85,
            usage_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,

        // epg_history (for catch-up)
        `CREATE TABLE IF NOT EXISTS epg_history (
            channel_key VARCHAR(255) NOT NULL,
            title VARCHAR(500),
            description TEXT,
            start_time BIGINT NOT NULL,
            stop_time BIGINT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (channel_key, start_time)
        )`,

        // logo_urls (for persistent logo URL tracking)
        `CREATE TABLE IF NOT EXISTS logo_urls (
            channel_id VARCHAR(255) PRIMARY KEY,
            url TEXT NOT NULL,
            source VARCHAR(50) DEFAULT 'unknown',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,

        // Indexes
        `CREATE INDEX IF NOT EXISTS idx_ai_overrides_confidence ON ai_overrides(confidence)`,
        `CREATE INDEX IF NOT EXISTS idx_ai_overrides_usage ON ai_overrides(usage_count DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_epg_history_channel ON epg_history(channel_key)`,
        `CREATE INDEX IF NOT EXISTS idx_epg_history_time ON epg_history(start_time)`,
        `CREATE INDEX IF NOT EXISTS idx_logo_urls_source ON logo_urls(source)`,
        `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,

        // epg_sources: which EPG providers to fetch, their URL pattern, coverage.
        `CREATE TABLE IF NOT EXISTS epg_sources (
            source VARCHAR(50) PRIMARY KEY,
            enabled BOOLEAN DEFAULT TRUE,
            kind VARCHAR(20),   -- 'general' | 'country' | 'aggregate'
            url TEXT,           -- base URL (or pattern)
            region VARCHAR(10), -- ISO cc or 'global'
            last_fetch BIGINT DEFAULT 0,
            last_success BIGINT DEFAULT 0,
            error_count INTEGER DEFAULT 0,
            notes TEXT
        )`,

        // epg_programs: central merged EPG store (source of truth).
        `CREATE TABLE IF NOT EXISTS epg_programs (
            channel_key VARCHAR(255) NOT NULL, -- canonical cId (e.g. 'global_cnn.us')
            source VARCHAR(50) NOT NULL,       -- 'epgshare01', 'imjhnz', ...
            title VARCHAR(500) NOT NULL,
            description TEXT,
            start_time BIGINT NOT NULL,
            stop_time BIGINT NOT NULL,
            PRIMARY KEY (channel_key, source, start_time)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_epg_programs_channel_time ON epg_programs(channel_key, start_time)`,
        `CREATE INDEX IF NOT EXISTS idx_epg_sources_enabled ON epg_sources(enabled)`
    ];

    for (const sql of statements) {
        try {
            await pool.query(sql);
        } catch (e) {
            // Ignore "already exists" errors, log others
            if (!e.message.includes('already exists') && !e.message.includes('duplicate')) {
                console.error('[DB Init] Schema error:', e.message);
            }
        }
    }

    console.log('[DB Init] Schema initialized (tables + indexes)');
}

module.exports = { initSchema };