const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder } = require('stremio-addon-sdk');
const { streamFetchIPTV, getEpgText, userCaches, MAX_CACHE_AGE } = require('./iptvParser');
const { loadCacheFromRedis, listCachedConfigKeys } = require('./redisCache');
const { getCatchupStreams, snapshotAllEpgToHistory } = require('./catchup');
const { getPremiumPoster } = require('./imageEngine');
const { initSchema } = require('./dbInit');
const { hashPassword, verifyPassword, generateSessionToken, decryptConfig } = require('./cryptoUtils');

const app = express();
app.use(cors());
app.use(express.json());

// Rate limiting middleware
const rateLimit = require('express-rate-limit');

// Enable trust proxy for rate limiter (needed when behind reverse proxy/docker)
// Set to 1 to trust first proxy (e.g., Docker, nginx) - prevents rate limit bypass
app.set('trust proxy', 1);

// General API rate limiter (applied to all /api routes)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Stricter rate limiter for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs for auth
    message: { error: 'Too many authentication attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for poster endpoints
const posterLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // limit each IP to 30 poster requests per minute
    message: { error: 'Too many poster requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for /health/detailed (expensive operation)
const healthDetailedLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 requests per minute
    message: { error: 'Too many health check requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for /api/get-groups (external API calls)
const getGroupsLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // limit each IP to 5 group discovery requests per minute
    message: { error: 'Too many group discovery requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for /api/test-config (external API calls)
const testConfigLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 connection tests per minute
    message: { error: 'Too many connection test requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for dashboard routes (GET / and GET /:config/configure)
const dashboardLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 50 dashboard requests per windowMs
    message: { error: 'Too many dashboard requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

/**
 * Produces a bounded, printable representation of a value for logging.
 * @param {string} str - The value to sanitize.
 * @returns {string} A printable string with control characters and structured-log delimiters replaced, limited to 200 characters.
 */
function sanitizeForLog(str) {
    if (!str) return '';
    return String(str)
        .replace(/[\r\n\t]/g, '?')
        .replace(/[^\x20-\x7E]/g, '?')  // Keep only printable ASCII
        .replace(/[%{}]/g, '?')  // Escape structured logging format chars
        .substring(0, 200);  // Limit length
}

/**
 * Validates a URL to prevent SSRF attacks.
 * Blocks private/internal IPs, localhost, and requires http/https scheme.
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if URL is safe to fetch
 */
function isSafeUrl(url) {
    if (!url || typeof url !== 'string') return false;

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost and loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;

    // Block private IPv4 ranges
    // 10.0.0.0/8
    if (/^10\./.test(hostname)) return false;
    // 172.16.0.0/12
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return false;
    // 192.168.0.0/16
    if (/^192\.168\./.test(hostname)) return false;
    // 169.254.0.0/16 (link-local)
    if (/^169\.254\./.test(hostname)) return false;

    // Block private IPv6 ranges
    // fc00::/7 (ULA)
    if (/^fc[0-9a-f]{2}:/i.test(hostname) || /^fd[0-9a-f]{2}:/i.test(hostname)) return false;
    // fe80::/10 (link-local)
    if (/^fe8[0-9a-f]:/i.test(hostname) || /^fe9[0-9a-f]:/i.test(hostname) || /^fea[0-9a-f]:/i.test(hostname) || /^feb[0-9a-f]:/i.test(hostname)) return false;

    // Block metadata services (cloud provider internal endpoints)
    if (hostname === '169.254.169.254' || hostname === '[fd00:ec2::254]') return false;

    return true;
}

// Session store (in-memory, for simplicity - can be moved to Redis later)
const sessions = new Map(); // token -> { userId, expiresAt, config }

// Session cleanup (every hour)
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
        if (session.expiresAt < now) sessions.delete(token);
    }
}, 60 * 60 * 1000);

// Serve dashboard (new structure)
app.get('/', dashboardLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});
app.get('/:config/configure', dashboardLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Serve dashboard assets
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

// Version endpoint
app.get('/api/version', (req, res) => {
    const pkg = require('./package.json');
    res.json({ version: pkg.version });
});

// Cache for the GitHub releases endpoint (server-side so the dashboard does not
// hold a token and is not rate-limited as an anonymous caller).
let releasesCache = null;
let releasesCacheTime = 0;
const RELEASES_REPO = 'oleglucic/IPTVo';
const RELEASES_TTL = 10 * 60 * 1000; // 10 minutes

app.get('/api/releases', dashboardLimiter, async (req, res) => {
    if (releasesCache && Date.now() - releasesCacheTime < RELEASES_TTL) {
        return res.json(releasesCache);
    }
    try {
        const resp = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases`, {
            headers: { 'User-Agent': 'IPTVo-dashboard', Accept: 'application/vnd.github+json' },
        });
        if (!resp.ok) throw new Error(`GitHub ${resp.status}`);
        const releases = await resp.json();
        const slim = (Array.isArray(releases) ? releases : []).map(r => ({
            tagName: r.tag_name,
            body: r.body || '',
            publishedAt: r.published_at || null,
            htmlUrl: r.html_url,
        }));
        releasesCache = { releases: slim };
        releasesCacheTime = Date.now();
        res.json({ releases: slim });
    } catch (err) {
        console.error('releases fetch failed:', err.message);
        res.status(502).json({ error: 'Failed to load releases' });
    }
});

// Apply general API rate limiting to all /api routes. Auth has its own
// stricter limiter registered later, so it isn't double-counted here.
app.use('/api/', apiLimiter);

// Require a valid bearer session for external-fetch endpoints so the server
// cannot be used as an anonymous fetch/SSRF proxy once open to the public.
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
        if (session) sessions.delete(token);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.session = session;
    next();
}

// Shallow Category Discovery Route (with stricter rate limiting)
app.post('/api/get-groups', requireAuth, getGroupsLimiter, async (req, res) => {
    const { type, m3uUrl, xtreamUrl, username, password } = req.body;
    try {
        if (type === 'xtream') {
            if (!xtreamUrl || !username || !password) return res.status(400).json({ error: "Missing Credentials" });
            const cleanUrl = xtreamUrl.replace(/\/$/, "");
            // Prevent SSRF: validate URL before fetching
            if (!isSafeUrl(cleanUrl)) {
                return res.status(400).json({ error: "Invalid Xtream URL: private/internal addresses not allowed" });
            }
            const apiRes = await axios.get(`${cleanUrl}/player_api.php?username=${username}&password=${password}&action=get_live_categories`, { timeout: 10000, maxRedirects: 0 });
            if (Array.isArray(apiRes.data)) {
                return res.json({ categories: apiRes.data.map(cat => cat.category_name).sort() });
            }
            return res.status(400).json({ error: "Invalid provider structure response" });
        } else {
            if (!m3uUrl) return res.status(400).json({ error: "Missing M3U Stream URL" });
            // Prevent SSRF: validate URL before fetching
            if (!isSafeUrl(m3uUrl)) {
                return res.status(400).json({ error: "Invalid M3U URL: private/internal addresses not allowed" });
            }
            const m3uRes = await axios.get(m3uUrl, { headers: { 'Range': 'bytes=0-5242880' }, timeout: 10000, maxRedirects: 0 });
            const lines = m3uRes.data.split('\n');
            const groups = new Set();
            for (const line of lines) {
                if (line.startsWith('#EXTINF:')) {
                    const match = line.match(/group-title="([^"]+)"/);
                    if (match && match[1]) groups.add(match[1]);
                }
            }
            return res.json({ categories: Array.from(groups).sort() });
        }
    } catch (err) {
        return res.status(500).json({ error: "Connection to provider failed: " + err.message });
    }
});

// Test provider connectivity (used by the dashboard "Test Connection" flow)
app.post('/api/test-config', requireAuth, testConfigLimiter, async (req, res) => {
    const { type, m3uUrl, xtreamUrl, username, password } = req.body;
    try {
        if (type === 'xtream') {
            if (!xtreamUrl || !username || !password) return res.status(400).json({ error: 'Missing Credentials' });
            const cleanUrl = xtreamUrl.replace(/\/$/, '');
            if (!isSafeUrl(cleanUrl)) return res.status(400).json({ error: 'Invalid Xtream URL: private/internal addresses not allowed' });
            // Never log credentials - only the panel host
            console.log(`[TestConfig] Testing Xtream panel at ${new URL(cleanUrl).host}`);
            const apiRes = await axios.get(`${cleanUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`, { timeout: 20000, maxRedirects: 0 });
            const streams = Array.isArray(apiRes.data) ? apiRes.data : [];
            if (streams.length === 0) {
                return res.status(400).json({ error: 'Connected, but no live channels returned (check credentials or panel URL)' });
            }
            const groupSet = new Set(streams.map(s => (s && (s.category_name || s.category_id)) || 'Uncategorized'));
            console.log(`[TestConfig] OK: ${streams.length} channels, ${groupSet.size} groups (xtream)`);
            return res.json({ channels: streams.length, groups: groupSet.size });
        }
        if (!m3uUrl) return res.status(400).json({ error: 'Missing M3U Stream URL' });
        if (!isSafeUrl(m3uUrl)) return res.status(400).json({ error: 'Invalid M3U URL: private/internal addresses not allowed' });
        console.log('[TestConfig] Fetching M3U playlist');
        const m3uRes = await axios.get(m3uUrl, { headers: { 'Range': 'bytes=0-5242880' }, responseType: 'arraybuffer', timeout: 20000, maxRedirects: 0 });
        const text = Buffer.from(m3uRes.data).toString('utf8');
        const lines = text.split('\n');
        let channels = 0;
        const groups = new Set();
        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                channels++;
                const match = line.match(/group-title=["']([^"']+)["']/i);
                if (match && match[1]) groups.add(match[1]);
            }
        }
        if (channels === 0) return res.status(400).json({ error: 'Connected, but no channels found in the playlist' });
        console.log(`[TestConfig] OK: ${channels} channels, ${groups.size} groups (m3u)`);
        return res.json({ channels, groups: groups.size });
    } catch (err) {
        const safeMsg = sanitizeForLog(err.message);
        console.error(`[TestConfig] Failed: ${safeMsg}`);
        return res.status(502).json({ error: `Connection failed: ${safeMsg || 'unable to reach provider'}` });
    }
});

// ============ STREMIO ADDON ENDPOINTS ============

/**
 * Extracts user configuration from request parameters, headers, or a legacy encoded configuration.
 * @param {Object} req - The request containing user ID or configuration data.
 * @returns {Object|null} The extracted user ID reference or decoded configuration, or `null` when extraction fails or no configuration is provided.
 */
function extractConfig(req) {
    try {
        // First check for user UUID in Authorization header or query param
        const userId = req.params.userId || req.query.userId || req.headers['x-user-id'];
        if (userId) {
            // Will be resolved async in ensureCache
            return { _userId: userId };
        }

        // Fallback to base64 config (legacy support)
        let rawB64 = (req.params.config || req.query.config || '');
        if (rawB64) {
            rawB64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
            while (rawB64.length % 4 !== 0) rawB64 += '=';
            const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
            try { return JSON.parse(decodeURIComponent(escape(decoded))); } catch {}
            return JSON.parse(decoded);
        }
        return null;
    } catch (e) {
        console.error('[extractConfig] Error:', sanitizeForLog(e.message));
        return null;
    }
}

// Ensure cache is populated before serving data routes
async function ensureCache(config, configObj) {
    // If configObj contains _userId, resolve the full config from database
    if (configObj && configObj._userId) {
        const user = await require('./db').getUserById(configObj._userId);
        if (user && user.encrypted_config && user.config_iv && user.config_salt) {
            const { decryptConfig } = require('./cryptoUtils');
            const resolvedConfig = await decryptConfig(user.encrypted_config, user.config_iv, user.config_salt, process.env.ENCRYPTION_KEY);
            if (resolvedConfig) {
                config = configObj._userId; // Use userId as cache key
                configObj = resolvedConfig;
                console.log(`[ensureCache] Resolved config for user: ${sanitizeForLog(configObj._userId)}`);
            }
        }
    }

    console.log(`[ensureCache] called for config=${config ? config.substring(0,12) : 'null'}... configObj=${!!configObj}`);
    if (!configObj) { console.log('[ensureCache] no configObj, returning null'); return null; }
    let cached = userCaches.get(config);
    console.log(`[ensureCache] cache state: ${sanitizeForLog(cached ? cached.status : 'MISSING')}`);

    // Total cache miss (cold start): check Redis first, then start background parse
    if (!cached) {
        const redisCached = await loadCacheFromRedis(config);
        if (redisCached && redisCached.status === 'ready') {
            userCaches.set(config, redisCached);
            // Log iptv-org match rate from cached data
            let iptvOrgMatchCount = 0;
            for (const [, channel] of redisCached.channelMap.entries()) {
                if (channel.meta.__iptvOrgMatch) iptvOrgMatchCount++;
            }
            console.log(`[ensureCache] rehydrated from Redis, channels=${redisCached.channelMap.size}, age=${Math.round((Date.now() - redisCached.lastUpdated)/60000)}min, iptv-org matched=${iptvOrgMatchCount}/${redisCached.channelMap.size} (${redisCached.channelMap.size > 0 ? Math.round(iptvOrgMatchCount * 100 / redisCached.channelMap.size) : 0}%)`);

            // Check if Redis cache is stale (older than 2 hours) - refresh in background
            if (Date.now() - redisCached.lastUpdated > 2 * 60 * 60 * 1000) {
                streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] background refresh failed:', sanitizeForLog(e.message)));
            }
            return redisCached;
        }

        console.log(`[ensureCache] cold-start: starting background parse, returning placeholder...`);
        // Start background parse WITHOUT waiting - just kick it off
        streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] fetch failed:', sanitizeForLog(e.message)));

        // Return a minimal "loading" cache so catalog can return empty but not timeout
        const loadingCache = {
            status: 'loading',
            channelMap: new Map(),
            logoTracker: new Map(),
            catalogItems: [],
            uniqueGroups: new Set(),
            epgData: {},
            lastUpdated: Date.now()
        };
        userCaches.set(config, loadingCache);
        return loadingCache;
    }

    // Already loading (e.g. triggered by a parallel request): wait for it with a generous timeout
    if (cached.status === 'loading') {
        const pollPromise = (async () => {
            while (userCaches.get(config) && userCaches.get(config).status === 'loading') {
                await new Promise(r => setTimeout(r, 500));
            }
        })();
        const timeoutPromise = new Promise(resolve => setTimeout(resolve, 600000)); // 10 min max wait for parallel request
        await Promise.race([pollPromise, timeoutPromise]);
        return userCaches.get(config);
    }

    // Ready but stale, or errored previously: refresh in the background, serve what we have now.
    if (cached.status === 'error' ||
        (cached.status === 'ready' && (Date.now() - cached.lastUpdated > 60 * 60 * 1000))) {
        streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] refresh failed:', sanitizeForLog(e.message)));
    }

    return cached;
}

app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Comprehensive health check endpoint (with rate limiting)
app.get('/health/detailed', healthDetailedLimiter, async (req, res) => {
    const configObj = extractConfig(req);
    const checks = {
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        server: { status: 'ok' },
        redis: { status: 'unknown' },
        postgres: { status: 'unknown' },
        iptvOrg: { status: 'unknown' },
        openrouter: { status: 'unknown' },
        config: { status: configObj ? 'provided' : 'none', type: configObj?.type },
        caches: {}
    };

    // Redis check
    const { hasRedis } = require('./redisCache');
    if (hasRedis) {
        try {
            const redis = require('ioredis');
            const client = new redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
            await client.ping();
            await client.quit();
            checks.redis = { status: 'ok' };
        } catch (e) {
            checks.redis = { status: 'error', error: e.message };
        }
    } else {
        checks.redis = { status: 'not_configured' };
    }

    // Postgres check
    const db = require('./db');
    if (db.hasSupabase) {
        try {
            const { Pool } = require('pg');
            const testPool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
            await testPool.query('SELECT 1');
            await testPool.end();
            checks.postgres = { status: 'ok' };
        } catch (e) {
            checks.postgres = { status: 'error', error: e.message };
        }
    } else {
        checks.postgres = { status: 'not_configured' };
    }

    // iptv-org check
    const { lastRefreshed } = require('./iptvOrgRef');
    if (lastRefreshed) {
        checks.iptvOrg = {
            status: 'ok',
            lastRefreshed: new Date(lastRefreshed).toISOString(),
            ageMinutes: Math.round((Date.now() - lastRefreshed) / 60000)
        };
    }

    // OpenRouter check (server env var only - per-config key removed)
    if (process.env.OPENROUTER_API_KEY) {
        try {
            const axios = require('axios');
            await axios.post('https://openrouter.ai/api/v1/auth/key', {}, {
                headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
                timeout: 3000
            });
            checks.openrouter = { status: 'ok' };
        } catch (e) {
            checks.openrouter = { status: 'error', error: e.message };
        }
    } else {
        checks.openrouter = { status: 'not_configured' };
    }

    // Cache status
    for (const [key, cached] of userCaches.entries()) {
        checks.caches[key.substring(0, 12)] = {
            status: cached.status,
            channels: cached.channelMap?.size || 0,
            groups: cached.uniqueGroups?.size || 0,
            ageMinutes: cached.lastUpdated ? Math.round((Date.now() - cached.lastUpdated) / 60000) : null
        };
    }

    // Determine overall status
    const criticalServices = ['redis', 'postgres'];
    const hasCriticalErrors = criticalServices.some(s => checks[s].status === 'error');
    const overallStatus = hasCriticalErrors ? 'degraded' : 'healthy';

    res.json({ overall: overallStatus, checks });
});

// ============ USER AUTHENTICATION ENDPOINTS ============

// Apply stricter rate limiting to auth endpoints
app.use('/api/auth/', authLimiter);

// Register new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, config } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        if (username.length < 3 || username.length > 50) {
            return res.status(400).json({ error: 'Username must be 3-50 characters' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const { createUser } = require('./db');
        const existing = await require('./db').getUserByUsername(username);
        if (existing) {
            return res.status(409).json({ error: 'Username already exists' });
        }

        const passwordHash = await hashPassword(password);
        const user = await createUser(username, passwordHash, config || {}, process.env.ENCRYPTION_KEY);
        if (!user) {
            return res.status(500).json({ error: 'Failed to create user' });
        }

        const token = generateSessionToken();
        sessions.set(token, {
            userId: user.user_id,
            username,
            config: config || {},
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
        });

        console.log(`[Auth] User registered: ${sanitizeForLog(username)} (${user.user_id})`);
        res.json({ success: true, username, userId: user.user_id, token });
    } catch (e) {
        console.error('[Auth] Register error:', sanitizeForLog(e.message));
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const user = await require('./db').getUserByUsername(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Decrypt user's stored config
        let config = {};
        if (user.encrypted_config && user.config_iv && user.config_salt) {
            config = await decryptConfig(user.encrypted_config, user.config_iv, user.config_salt, process.env.ENCRYPTION_KEY) || {};
        }

        const token = generateSessionToken();
        sessions.set(token, {
            userId: user.user_id,
            username: user.username,
            config,
            expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
        });

        console.log(`[Auth] User logged in: ${sanitizeForLog(username)} (${user.user_id})`);
        // Redact sensitive config fields in response
        const safeConfig = { ...config };
        if (safeConfig.password) safeConfig.password = '[REDACTED]';
        if (safeConfig.openrouterKey) safeConfig.openrouterKey = '[REDACTED]';
        if (safeConfig.xtreamUrl) {
            try {
                const url = new URL(safeConfig.xtreamUrl);
                if (url.username || url.password) {
                    url.username = '';
                    url.password = '[REDACTED]';
                    safeConfig.xtreamUrl = url.toString();
                }
            } catch {
                // Fallback: simple string replace without regex backtracking
                const atIdx = safeConfig.xtreamUrl.lastIndexOf('@');
                if (atIdx > 0) {
                    const protoIdx = safeConfig.xtreamUrl.lastIndexOf('://', atIdx);
                    if (protoIdx >= 0) {
                        safeConfig.xtreamUrl = safeConfig.xtreamUrl.substring(0, protoIdx + 3) + '[REDACTED]@' + safeConfig.xtreamUrl.substring(atIdx + 1);
                    }
                }
            }
        }
        res.json({ success: true, username: user.username, userId: user.user_id, token, config: safeConfig });
    } catch (e) {
        console.error('[Auth] Login error:', sanitizeForLog(e.message));
        res.status(500).json({ error: 'Login failed' });
    }
});

// Validate session
app.get('/api/auth/validate', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }
    const token = authHeader.slice(7);
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
        if (session) sessions.delete(token);
        return res.status(401).json({ valid: false });
    }
    const safeConfig = { ...session.config };
    if (safeConfig.password) safeConfig.password = '[REDACTED]';
    if (safeConfig.openrouterKey) safeConfig.openrouterKey = '[REDACTED]';
    if (safeConfig.xtreamUrl) {
            try {
                const url = new URL(safeConfig.xtreamUrl);
                if (url.username || url.password) {
                    url.username = '';
                    url.password = '[REDACTED]';
                    safeConfig.xtreamUrl = url.toString();
                }
            } catch {
                // Fallback: simple string replace without regex backtracking
                const atIdx = safeConfig.xtreamUrl.lastIndexOf('@');
                if (atIdx > 0) {
                    const protoIdx = safeConfig.xtreamUrl.lastIndexOf('://', atIdx);
                    if (protoIdx >= 0) {
                        safeConfig.xtreamUrl = safeConfig.xtreamUrl.substring(0, protoIdx + 3) + '[REDACTED]@' + safeConfig.xtreamUrl.substring(atIdx + 1);
                    }
                }
            }
        }
    res.json({ valid: true, userId: session.userId, username: session.username, config: safeConfig });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        sessions.delete(authHeader.slice(7));
    }
    res.json({ success: true });
});

// Get logo proxy URL (for dashboard)
app.get('/api/logo-proxy-url', (req, res) => {
    const url = process.env.LOGO_PROXY_URL;
    if (url) {
        res.json({ url });
    } else {
        res.status(404).json({ error: 'Logo proxy URL not configured' });
    }
});

// Update user config (encrypted)
app.put('/api/auth/config', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.slice(7);
        const session = sessions.get(token);
        if (!session || session.expiresAt < Date.now()) {
            if (session) sessions.delete(token);
            return res.status(401).json({ error: 'Session expired' });
        }

        const { config } = req.body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ error: 'Config object required' });
        }

        const { updateUserConfig } = require('./db');
        const success = await updateUserConfig(session.userId, config, process.env.ENCRYPTION_KEY);
        if (!success) {
            return res.status(500).json({ error: 'Failed to update config' });
        }

        // Update session config
        session.config = config;
        sessions.set(token, session);

        console.log(`[Auth] Config updated for user: ${sanitizeForLog(session.userId)}`);
console.log(`[Auth] Password changed for user: ${sanitizeForLog(session.userId)}`);
console.log(`[Auth] Account deleted for user: ${sanitizeForLog(session.userId)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Auth] Config update error:', sanitizeForLog(e.message));
        res.status(500).json({ error: 'Config update failed' });
    }
});

// Change password
app.put('/api/auth/password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.slice(7);
        const session = sessions.get(token);
        if (!session || session.expiresAt < Date.now()) {
            if (session) sessions.delete(token);
            return res.status(401).json({ error: 'Session expired' });
        }

        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const { getUserById } = require('./db');
        const { hashPassword } = require('./cryptoUtils');

        const user = await getUserById(session.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const valid = await verifyPassword(currentPassword, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = await hashPassword(newPassword);
        const pool = require('./db').pool;
        if (pool) {
            await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE user_id = $2', [newHash, session.userId]);
        }

        console.log(`[Auth] Password changed for user: ${sanitizeForLog(session.userId)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Auth] Password change error:', sanitizeForLog(e.message));
        res.status(500).json({ error: 'Password change failed' });
    }
});

// Delete account
app.delete('/api/auth/account', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = authHeader.slice(7);
        const session = sessions.get(token);
        if (!session || session.expiresAt < Date.now()) {
            if (session) sessions.delete(token);
            return res.status(401).json({ error: 'Session expired' });
        }

        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password required for confirmation' });
        }

        const { getUserById } = require('./db');
        const user = await getUserById(session.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Password is incorrect' });
        }

        const pool = require('./db').pool;
        if (pool) {
            await pool.query('DELETE FROM users WHERE user_id = $1', [session.userId]);
        }
        sessions.delete(token);

        console.log(`[Auth] Account deleted for user: ${sanitizeForLog(session.userId)}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[Auth] Account deletion error:', sanitizeForLog(e.message));
        res.status(500).json({ error: 'Account deletion failed' });
    }
});

const pkg = require('./package.json');

const builder = new addonBuilder({
    id: 'iptvo.oleglucic.com',
    version: pkg.version,
    name: 'IPTVo',
    description: 'AI Curation Stack & Intelligent Catalog Filter Layer for Live IPTV',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    behaviorHints: { configurable: true, configurationRequired: false },
    posterShape: 'square', // posters are 1:1 (channel logo on a backdrop) — square placeholders keep the client's skeleton consistent with the served poster
    catalogs: [{
        type: 'tv',
        id: 'iptvo_live',
        name: 'IPTVo Live TV',
        extra: [
            { name: 'genre', isRequired: false },
            { name: 'search', isRequired: false }
        ]
    }],
    idPrefixes: ['global_', 'us_', 'uk_', 'gb_', 'de_', 'fr_', 'es_', 'it_', 'ca_', 'au_', 'nl_', 'be_', 'pt_', 'gr_', 'pl_', 'cz_', 'hu_', 'ro_', 'rs_', 'hr_', 'si_', 'sk_', 'lt_', 'lv_', 'ee_', 'fi_', 'se_', 'no_', 'dk_', 'at_', 'ch_', 'ie_', 'bg_', 'cy_', 'mt_', 'lu_', 'is_', 'li_', 'mc_', 'sm_', 'va_', 'ad_', 'me_', 'mk_', 'al_', 'ba_', 'xk_', 'md_', 'ge_', 'am_', 'az_', 'by_', 'ua_', 'ru_', 'kz_', 'uz_', 'kg_', 'tj_', 'tm_', 'mn_', 'cn_', 'jp_', 'kr_', 'kp_', 'tw_', 'hk_', 'mo_', 'sg_', 'my_', 'th_', 'vn_', 'ph_', 'id_', 'bn_', 'kh_', 'la_', 'mm_', 'np_', 'bd_', 'lk_', 'mv_', 'bt_', 'af_', 'pk_', 'ir_', 'iq_', 'il_', 'jo_', 'lb_', 'sy_', 'ps_', 'sa_', 'ye_', 'om_', 'ae_', 'qa_', 'bh_', 'kw_', 'tr_', 'eg_', 'ly_', 'tn_', 'dz_', 'ma_', 'mr_', 'ml_', 'ne_', 'td_', 'cf_', 'cm_', 'ga_', 'gq_', 'st_', 'ao_', 'zw_', 'zm_', 'mw_', 'mz_', 'na_', 'bw_', 'ls_', 'sz_', 'za_', 'ng_', 'gh_', 'ci_', 'sn_', 'sl_', 'lr_', 'gn_', 'gw_', 'cv_', 'sc_', 'mu_', 'mg_', 'km_', 'dj_', 'er_', 'et_', 'so_', 'ke_', 'ug_', 'rw_', 'bi_', 'tz_', 'cd_', 'cg_', 'rn_', 're_', 'yt_', 'tf_', 'hm_', 'bv_', 'sj_', 'aq_']
});

// Catalog handler (tv catalogs)
builder.defineCatalogHandler(async ({ _type, _id, extra, config }) => {
    const configKey = config.configKey;
    const configObj = config.configObj;
    const rootUrl = config.rootUrl;
    console.log(`[Catalog] request received, configObj parsed=${!!configObj}, genre=${sanitizeForLog(extra?.genre)}, search=${sanitizeForLog(extra?.search)}`);
    if (!configObj) return { metas: [] };

    const ud = await ensureCache(configKey, configObj);
    if (!ud || !ud.channelMap) return { metas: [] };

    const selectedGenre = extra?.genre?.replace(/-/g, ' ') || null;
    const selectedSearch = extra?.search?.toLowerCase() || null;

    const metas = [];
    for (const [chKey, channel] of ud.channelMap.entries()) {
        if (selectedGenre && channel.meta.group !== selectedGenre) continue;
        if (selectedSearch && !channel.meta.name.toLowerCase().includes(selectedSearch)) continue;

        const engineImage = `${rootUrl}/${configKey}/poster/${chKey}.png?t=${ud.lastUpdated}`;
        const passedThroughLogo = channel.meta.logo || engineImage;
        const epgDescription = getEpgText(chKey, ud.epgData, configObj.timezoneOffset || 0);
        const aggregatedTagsArr = [...new Set(channel.streams.flatMap(s => [
            ...(s.groupTags ? s.groupTags.split(" • ") : []),
            ...((s.title && s.title !== "Direct Stream") ? s.title.split(" • ") : [])
        ]))];
        if (channel.meta.hasCatchup) aggregatedTagsArr.push(`Catch-up${channel.meta.catchupDays ? ` (${channel.meta.catchupDays}d)` : ''}`);
        const aggregatedTags = aggregatedTagsArr.join(" • ");
        const fullDescription = aggregatedTags && aggregatedTags.length > 0 ? `🎬 ${aggregatedTags}\n\n${epgDescription}` : epgDescription;

        metas.push({
            id: channel.meta.id,
            type: 'tv',
            name: channel.meta.name,
            poster: engineImage,
            background: engineImage,
            logo: passedThroughLogo,
            description: fullDescription,
            genres: [channel.meta.group]
        });
    }
    console.log(`[Catalog] responding with ${sanitizeForLog(metas.length)} metas`);
    return { metas };
});

// Meta handler
builder.defineMetaHandler(async ({ _type, _id, _extra, config }) => {
    const configKey = config.configKey;
    const configObj = config.configObj;
    const rootUrl = config.rootUrl;

    await ensureCache(configKey, configObj);
    const ud = userCaches.get(configKey);
    if (!ud || !ud.channelMap.has(id)) return { meta: {} };
    const channel = ud.channelMap.get(id);

    const engineImage = `${rootUrl}/${configKey}/poster/${encodeURIComponent(id)}.png?t=${ud.lastUpdated}`;
    const passedThroughLogo = channel.meta.logo || engineImage;
    const epgDescription = getEpgText(id, ud.epgData, configObj ? configObj.timezoneOffset : 0);
    const aggregatedTagsArr = [...new Set(channel.streams.flatMap(s => [
        ...(s.groupTags ? s.groupTags.split(" • ") : []),
        ...((s.title && s.title !== "Direct Stream") ? s.title.split(" • ") : [])
    ]))];
    if (channel.meta.hasCatchup) aggregatedTagsArr.push(`Catch-up${channel.meta.catchupDays ? ` (${channel.meta.catchupDays}d)` : ''}`);
    const aggregatedTags = aggregatedTagsArr.join(" • ");
    const fullDescription = aggregatedTags && aggregatedTags.length > 0 ? `🎬 ${aggregatedTags}\n\n${epgDescription}` : epgDescription;

    return {
        meta: {
            id: channel.meta.id,
            type: 'tv',
            name: channel.meta.name,
            poster: engineImage,
            background: engineImage,
            logo: passedThroughLogo,
            description: fullDescription
        }
    };
});

// Stream handler
builder.defineStreamHandler(async ({ _type, _id, _extra, config }) => {
    const configKey = config.configKey;
    const configObj = config.configObj;

    await ensureCache(configKey, configObj);
    const ud = userCaches.get(configKey);
    if (!ud || !ud.channelMap.has(id)) return { streams: [] };
    const channel = ud.channelMap.get(id);

    const streamsToReturn = channel.streams
        .sort((a, b) => b.score - a.score)
        .map(stream => ({
            name: stream.name,
            title: (() => {
                const t = new Set();
                if (stream.title && stream.title !== 'Direct Stream') stream.title.split(' • ').forEach(x => t.add(x));
                if (stream.groupTags) stream.groupTags.split(' • ').forEach(x => t.add(x));
                return t.size > 0 ? [...t].join(' • ') : 'Direct Stream';
            })(),
            url: stream.url
        }));

    let catchupEntries = [];
    if (channel.meta.hasCatchup && channel.streams.length > 0) {
        try {
            catchupEntries = await getCatchupStreams(id, channel.streams[0].url, 48);
        } catch (e) {
            console.error('[Catchup] Failed to build catchup streams:', sanitizeForLog(e.message));
        }
    }

    return { streams: [...streamsToReturn, ...catchupEntries] };
});

// Get the addon interface and serve it via express
const addonInterface = builder.getInterface();

// Helper to extract configKey and configObj from request
async function getConfigFromReq(req) {
    // Check for user UUID first (new system)
    const userId = req.params.userId;
    if (userId) {
        const configObj = extractConfig(req);
        return { configKey: userId, configObj };
    }

    // Fallback to legacy base64 config
    const configKey = req.params.config;
    const configObj = extractConfig(req);
    return { configKey, configObj };
}

// Mount the addon routes on express - NEW USER SYSTEM ROUTES
app.get('/:userId/manifest.json', (req, res) => {
    res.json(addonInterface.manifest);
});

app.get('/:userId/catalog/:type/:id.json', async (req, res, next) => {
    try {
        const { configKey, configObj } = await getConfigFromReq(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'catalog';
        const type = req.params.type;
        const id = req.params.id;
        const extra = req.params.extra || {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/:userId/catalog/:type/:id/:extra.json', async (req, res, next) => {
    try {
        const { configKey, configObj } = await getConfigFromReq(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'catalog';
        const type = req.params.type;
        const id = req.params.id;
        const extra = req.params.extra || {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/:userId/meta/:type/:id.json', async (req, res, next) => {
    try {
        const { configKey, configObj } = await getConfigFromReq(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'meta';
        const type = req.params.type;
        const id = req.params.id;
        const extra = {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/:userId/stream/:type/:id.json', async (req, res, next) => {
    try {
        const { configKey, configObj } = await getConfigFromReq(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'stream';
        const type = req.params.type;
        const id = req.params.id;
        const extra = {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// Poster route - user system (with rate limiting)
app.get('/:userId/poster/:id.png', posterLimiter, async (req, res) => {
    const { configKey, configObj } = await getConfigFromReq(req);
    const id = decodeURIComponent(req.params.id);

    // Validate channel ID to prevent path traversal (CodeQL: path injection)
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).send("Invalid channel ID");
    }

    await ensureCache(configKey, configObj);
    const ud = userCaches.get(configKey);
    let logoUrl = null;
    let channelName = "Live TV";

    if (ud && ud.channelMap.has(id)) {
        const channel = ud.channelMap.get(id);
        logoUrl = channel.meta.logo;
        channelName = channel.meta.name;
    }

    try {
        const cachedPosterPath = await getPremiumPoster(id, logoUrl, channelName);
        // Resolve path to prevent path injection - ensure it's within cache dir
        const resolvedPath = path.resolve(cachedPosterPath);
        const cacheDir = path.join(__dirname, 'cache');
        if (!resolvedPath.startsWith(cacheDir)) {
            return res.status(500).send("Invalid poster path");
        }
        res.sendFile(resolvedPath);
    } catch (error) {
        console.error("[Poster Generation Error]", sanitizeForLog(error.message));
        res.status(500).send("Error compiling image layer context");
    }
});

// Legacy routes for backward compatibility (base64 config)
app.get('/:config/manifest.json', (req, res) => {
    res.json(addonInterface.manifest);
});

app.get('/:config/catalog/:type/:id.json', async (req, res, next) => {
    try {
        const configKey = req.params.config;
        const configObj = extractConfig(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'catalog';
        const type = req.params.type;
        const id = req.params.id;
        const extra = req.params.extra || {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/:config/catalog/:type/:id/:extra.json', async (req, res, next) => {
    try {
        const configKey = req.params.config;
        const configObj = extractConfig(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'catalog';
        const type = req.params.type;
        const id = req.params.id;
        const extra = req.params.extra || {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/:config/meta/:type/:id.json', async (req, res, next) => {
    try {
        const configKey = req.params.config;
        const configObj = extractConfig(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'meta';
        const type = req.params.type;
        const id = req.params.id;
        const extra = {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/:config/stream/:type/:id.json', async (req, res, next) => {
    try {
        const configKey = req.params.config;
        const configObj = extractConfig(req);
        const rootUrl = `${req.protocol}://${req.get('host')}`;
        const resource = 'stream';
        const type = req.params.type;
        const id = req.params.id;
        const extra = {};
        const config = { configKey, configObj, rootUrl };
        const result = await addonInterface.get(resource, type, id, extra, config);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// Poster route - legacy (with rate limiting)
app.get('/:config/poster/:id.png', posterLimiter, async (req, res) => {
    const config = req.params.config;
    const id = decodeURIComponent(req.params.id);
    const configObj = extractConfig(req);

    // Validate channel ID to prevent path traversal (CodeQL: path injection)
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).send("Invalid channel ID");
    }

    await ensureCache(config, configObj);
    const ud = userCaches.get(config);
    let logoUrl = null;
    let channelName = "Live TV";

    if (ud && ud.channelMap.has(id)) {
        const channel = ud.channelMap.get(id);
        logoUrl = channel.meta.logo;
        channelName = channel.meta.name;
    }

    try {
        const cachedPosterPath = await getPremiumPoster(id, logoUrl, channelName);
        // Resolve path to prevent path injection - ensure it's within cache dir
        const resolvedPath = path.resolve(cachedPosterPath);
        const cacheDir = path.join(__dirname, 'cache');
        if (!resolvedPath.startsWith(cacheDir)) {
            return res.status(500).send("Invalid poster path");
        }
        res.sendFile(resolvedPath);
    } catch (error) {
        console.error("[Poster Generation Error]", sanitizeForLog(error.message));
        res.status(500).send("Error compiling image layer context");
    }
});

const { startAutoRefresh: startIptvOrgRefresh } = require('./iptvOrgRef');
const { backgroundLogoRefresh } = require('./iptvParser');
const PORT = process.env.PORT || 3000;

// Initialize database schema (creates tables if missing)
(async () => {
    try {
        await initSchema();
    } catch (e) {
        console.error('[DB Init] Failed:', sanitizeForLog(e.message));
    }

    startIptvOrgRefresh();

    // Background logo refresh - only refreshes logos with changed URLs (runs every 6 hours)
    setInterval(() => {
        backgroundLogoRefresh().catch(e => console.error('[LogoRefresh] Cycle failed:', sanitizeForLog(e.message)));
    }, 6 * 60 * 60 * 1000); // 6 hours
    // Also run once on startup after a delay
    setTimeout(() => {
        backgroundLogoRefresh().catch(e => console.error('[LogoRefresh] Initial run failed:', sanitizeForLog(e.message)));
    }, 5 * 60 * 1000); // 5 min after startup

    // Periodically snapshot EPG data into persistent history for catch-up (XMLTV feeds are forward-looking only)
    setInterval(() => {
        snapshotAllEpgToHistory(userCaches).catch(e => console.error('[Catchup] Snapshot cycle failed:', sanitizeForLog(e.message)));
    }, 30 * 60 * 1000);
    setTimeout(() => {
        snapshotAllEpgToHistory(userCaches).catch(e => console.error('[Catchup] Initial snapshot failed:', sanitizeForLog(e.message)));
    }, 2 * 60 * 1000);

    // Proactively refresh any cached config older than MAX_CACHE_AGE, independent of
    // incoming requests - so the cache stays fresh even during idle periods.
    setInterval(() => {
        for (const [configKey, cached] of userCaches.entries()) {
            if (cached && cached.status === 'ready' && (Date.now() - cached.lastUpdated > MAX_CACHE_AGE)) {
                // Extract the full config object including openrouterKey from the config key
                // The configKey is the base64-encoded config, so we can decode it
                try {
                    const configObj = extractConfig({ params: { config: configKey }, query: {} });
                    if (configObj) {
                        console.log(`[ProactiveRefresh] configObj keys: ${sanitizeForLog(Object.keys(configObj).join(', '))}, openrouterKey present: ${!!configObj.openrouterKey}, ai: ${sanitizeForLog(configObj.ai)}`);
                        console.log(`[ProactiveRefresh] refreshing stale config=${sanitizeForLog(configKey.substring(0,12))}...`);
                        streamFetchIPTV(configKey, configObj).catch(e => console.error('[ProactiveRefresh] failed:', sanitizeForLog(e.message)));
                    }
                } catch (e) {
                    console.error(`[ProactiveRefresh] Failed to extract config for ${sanitizeForLog(configKey)}:`, sanitizeForLog(e.message));
                }
            }
        }
    }, 15 * 60 * 1000);

    // Pre-warm the in-memory cache from Redis on boot, so the very first request
    // after a container restart is instant instead of needing a full re-parse.
    (async () => {
        const keys = await listCachedConfigKeys();
        for (const key of keys) {
            const cached = await loadCacheFromRedis(key);
            if (cached && cached.status === 'ready') {
                userCaches.set(key, cached);
                // Log iptv-org match rate from boot-loaded cache
                let iptvOrgMatchCount = 0;
                for (const [, channel] of cached.channelMap.entries()) {
                    if (channel.meta.__iptvOrgMatch) iptvOrgMatchCount++;
                }
                console.log(`[Boot] Pre-warmed config=${sanitizeForLog(key.substring(0,12))}... channels=${cached.channelMap.size}, iptv-org matched=${iptvOrgMatchCount}/${cached.channelMap.size} (${cached.channelMap.size > 0 ? Math.round(iptvOrgMatchCount * 100 / cached.channelMap.size) : 0}%)`);
            }
        }
        console.log(`[Boot] Pre-warmed ${keys.length} config(s) from Redis.`);
    })();

    app.listen(PORT, () => console.log(`IPTVo Premium Backend operational on port ${PORT}`));
})();