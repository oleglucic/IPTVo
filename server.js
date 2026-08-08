const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { streamFetchIPTV, getEpgText, userCaches, MAX_CACHE_AGE } = require('./iptvParser');
const { loadCacheFromRedis, listCachedConfigKeys } = require('./redisCache');
const { getCatchupStreams, snapshotAllEpgToHistory } = require('./catchup');
const { getPremiumPoster } = require('./imageEngine');
const { initSchema } = require('./dbInit');

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});
app.get('/:config/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Shallow Category Discovery Route
app.post('/api/get-groups', async (req, res) => {
    const { type, m3uUrl, xtreamUrl, username, password } = req.body;
    try {
        if (type === 'xtream') {
            if (!xtreamUrl || !username || !password) return res.status(400).json({ error: "Missing Credentials" });
            const cleanUrl = xtreamUrl.replace(/\/$/, "");
            const apiRes = await axios.get(`${cleanUrl}/player_api.php?username=${username}&password=${password}&action=get_live_categories`, { timeout: 10000 });
            if (Array.isArray(apiRes.data)) {
                return res.json({ categories: apiRes.data.map(cat => cat.category_name).sort() });
            }
            return res.status(400).json({ error: "Invalid provider structure response" });
        } else {
            if (!m3uUrl) return res.status(400).json({ error: "Missing M3U Stream URL" });
            const m3uRes = await axios.get(m3uUrl, { headers: { 'Range': 'bytes=0-5242880' }, timeout: 10000 });
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

// Stremio Addon Configuration Parsing
function extractConfig(req) {
    try {
        let rawB64 = (req.params.config || req.query.config || '');
        console.log(`[extractConfig] rawB64 (first 80): ${rawB64.substring(0, 80)}`);
        rawB64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
        // Pad to a multiple of 4
        while (rawB64.length % 4 !== 0) rawB64 += '=';
        const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
        console.log(`[extractConfig] decoded: ${decoded}`);
        // Handle btoa(unescape(encodeURIComponent(...))) encoding from dashboard
        try { return JSON.parse(decodeURIComponent(escape(decoded))); } catch (_) {}
        return JSON.parse(decoded);
    } catch (e) {
        console.error('[extractConfig] Error:', e.message);
        return null;
    }
}

// Ensure cache is populated before serving data routes
async function ensureCache(config, configObj) {
    console.log(`[ensureCache] called for config=${config ? config.substring(0,12) : 'null'}... configObj=${!!configObj}`);
    if (!configObj) { console.log('[ensureCache] no configObj, returning null'); return null; }
    let cached = userCaches.get(config);
    console.log(`[ensureCache] cache state: ${cached ? cached.status : 'MISSING'}`);

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
                streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] background refresh failed:', e.message));
            }
            return redisCached;
        }

        console.log(`[ensureCache] cold-start: starting background parse, returning placeholder...`);
        // Start background parse WITHOUT waiting - just kick it off
        streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] fetch failed:', e.message));

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
        streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] refresh failed:', e.message));
    }

    return cached;
}

app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Comprehensive health check endpoint
app.get('/health/detailed', async (req, res) => {
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

// Internal test endpoint for validating a config
app.post('/api/test-config', async (req, res) => {
    const configObj = req.body;
    if (!configObj || !configObj.type) {
        return res.status(400).json({ error: 'Missing config type (m3u or xtream)' });
    }

    const testKey = 'test_' + Date.now();
    const testConfigObj = { ...configObj };
    testConfigObj._test = true;

    try {
        console.log(`[TestConfig] Starting test for ${configObj.type}...`);
        const result = await require('./iptvParser').streamFetchIPTV(testKey, testConfigObj);
        const cached = require('./iptvParser').userCaches.get(testKey);

        // Clean up test cache
        require('./iptvParser').userCaches.delete(testKey);

        if (!cached || cached.status !== 'ready') {
            return res.status(500).json({
                success: false,
                error: cached?.message || 'Parsing did not complete',
                status: cached?.status
            });
        }

        res.json({
            success: true,
            channels: cached.channelMap.size,
            groups: cached.uniqueGroups.size,
            groupNames: Array.from(cached.uniqueGroups).sort(),
            parseTimeMs: Date.now() - (cached.lastUpdated || Date.now()),
            epgChannels: Object.keys(cached.epgData || {}).length
        });
    } catch (e) {
        require('./iptvParser').userCaches.delete(testKey);
        console.error('[TestConfig] Failed:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Stremio Addon SDK Builder
const builder = new addonBuilder({
    id: 'iptvo.oleglucic.com',
    version: '0.0.1',
    name: 'IPTVo',
    description: 'AI Curation Stack & Intelligent Catalog Filter Layer for Live IPTV',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    behaviorHints: { configurable: true, configurationRequired: false },
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

async function getChannelData(config, id, configObj) {
    await ensureCache(config, configObj);
    const ud = userCaches.get(config);
    if (!ud || !ud.channelMap.has(id)) return null;
    return ud.channelMap.get(id);
}

// Catalog handler (tv catalogs)
builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
    const configKey = config.configKey;
    const configObj = config.configObj;
    const rootUrl = config.rootUrl;
    console.log(`[Catalog] request received, configObj parsed=${!!configObj}, genre=${extra?.genre}, search=${extra?.search}`);
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
    console.log(`[Catalog] responding with ${metas.length} metas`);
    return { metas };
});

// Meta handler
builder.defineMetaHandler(async ({ type, id, extra, config }) => {
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
builder.defineStreamHandler(async ({ type, id, extra, config }) => {
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
            console.error('[Catchup] Failed to build catchup streams:', e.message);
        }
    }

    return { streams: [...streamsToReturn, ...catchupEntries] };
});

// Get the addon interface and serve it via express
const addonInterface = builder.getInterface();

// Mount the addon routes on express
app.get('/:config/manifest.json', (req, res) => {
    // The manifest is the same for all configs, so just return it
    res.json(addonInterface.manifest);
});

// Catalog routes - using the unified get() method from stremio-addon-sdk v1.6+
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

// Meta route
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

// Stream route
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

// Fallback Canvas Image Generator Route
app.get('/:config/poster/:id.png', async (req, res) => {
    const config = req.params.config;
    const id = decodeURIComponent(req.params.id);
    const configObj = extractConfig(req);

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
        res.sendFile(cachedPosterPath);
    } catch (error) {
        console.error("[Poster Generation Error]", error.message);
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
        console.error('[DB Init] Failed:', e.message);
    }

    startIptvOrgRefresh();

    // Background logo refresh - only refreshes logos with changed URLs (runs every 6 hours)
    setInterval(() => {
        backgroundLogoRefresh().catch(e => console.error('[LogoRefresh] Cycle failed:', e.message));
    }, 6 * 60 * 60 * 1000); // 6 hours
    // Also run once on startup after a delay
    setTimeout(() => {
        backgroundLogoRefresh().catch(e => console.error('[LogoRefresh] Initial run failed:', e.message));
    }, 5 * 60 * 1000); // 5 min after startup

    // Periodically snapshot EPG data into persistent history for catch-up (XMLTV feeds are forward-looking only)
    setInterval(() => {
        snapshotAllEpgToHistory(userCaches).catch(e => console.error('[Catchup] Snapshot cycle failed:', e.message));
    }, 30 * 60 * 1000);
    setTimeout(() => {
        snapshotAllEpgToHistory(userCaches).catch(e => console.error('[Catchup] Initial snapshot failed:', e.message));
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
                        console.log(`[ProactiveRefresh] configObj keys: ${Object.keys(configObj).join(', ')}, openrouterKey present: ${!!configObj.openrouterKey}, ai: ${configObj.ai}`);
                        console.log(`[ProactiveRefresh] refreshing stale config=${configKey.substring(0,12)}...`);
                        streamFetchIPTV(configKey, configObj).catch(e => console.error('[ProactiveRefresh] failed:', e.message));
                    }
                } catch (e) {
                    console.error(`[ProactiveRefresh] Failed to extract config for ${configKey}:`, e.message);
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
                console.log(`[Boot] Pre-warmed config=${key.substring(0,12)}... channels=${cached.channelMap.size}, iptv-org matched=${iptvOrgMatchCount}/${cached.channelMap.size} (${cached.channelMap.size > 0 ? Math.round(iptvOrgMatchCount * 100 / cached.channelMap.size) : 0}%)`);
            }
        }
        console.log(`[Boot] Pre-warmed ${keys.length} config(s) from Redis.`);
    })();

    app.listen(PORT, () => console.log(`IPTVo Premium Backend operational on port ${PORT}`));
})();