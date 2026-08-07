const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { streamFetchIPTV, getEpgText, userCaches, MAX_CACHE_AGE } = require('./iptvParser');
const { loadCacheFromRedis, listCachedConfigKeys } = require('./redisCache');
const { getCatchupStreams, snapshotAllEpgToHistory } = require('./catchup');
const { getPremiumPoster } = require('./imageEngine');

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
        rawB64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
        // Pad to a multiple of 4
        while (rawB64.length % 4 !== 0) rawB64 += '=';
        const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
        // Handle btoa(unescape(encodeURIComponent(...))) encoding from dashboard
        try { return JSON.parse(decodeURIComponent(escape(decoded))); } catch (_) {}
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

// Ensure cache is populated before serving data routes
async function ensureCache(config, configObj) {
    console.log(`[ensureCache] called for config=${config ? config.substring(0,12) : 'null'}... configObj=${!!configObj}`);
    if (!configObj) { console.log('[ensureCache] no configObj, returning null'); return null; }
    let cached = userCaches.get(config);
    console.log(`[ensureCache] cache state: ${cached ? cached.status : 'MISSING'}`);

    // Total cache miss (cold start): kick off the fetch and wait briefly for it,
    // so we don't return an empty catalog when the parse would finish in time anyway.
    if (!cached) {
        const redisCached = await loadCacheFromRedis(config);
        if (redisCached && redisCached.status === 'ready') {
            userCaches.set(config, redisCached);
            console.log(`[ensureCache] rehydrated from Redis, channels=${redisCached.channelMap.size}, age=${Math.round((Date.now() - redisCached.lastUpdated)/60000)}min`);
            if (Date.now() - redisCached.lastUpdated > 60 * 60 * 1000) {
                streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] background refresh failed:', e.message));
            }
            return redisCached;
        }
        const fetchPromise = streamFetchIPTV(config, configObj).catch(e => console.error('[ensureCache] fetch failed:', e.message));
        const timeoutPromise = new Promise(resolve => setTimeout(resolve, 6000));
        await Promise.race([fetchPromise, timeoutPromise]);
        const result = userCaches.get(config);
        console.log(`[ensureCache] cold-start wait finished, status=${result ? result.status : 'STILL MISSING'}, channels=${result && result.channelMap ? result.channelMap.size : 0}`);
        return result;
    }

    // Already loading (e.g. triggered by a parallel request): wait a bit for it too.
    if (cached.status === 'loading') {
        const pollPromise = (async () => {
            while (userCaches.get(config) && userCaches.get(config).status === 'loading') {
                await new Promise(r => setTimeout(r, 300));
            }
        })();
        const timeoutPromise = new Promise(resolve => setTimeout(resolve, 6000));
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

// Stremio Addon SDK Builder
const builder = new addonBuilder({
    id: 'org.iptvo.premium',
    version: '1.0.0',
    name: 'IPTVo Premium',
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
builder.defineCatalogHandler(async (args, req) => {
    const config = req.params.config;
    const configObj = extractConfig(req);
    console.log(`[Catalog] request received, configObj parsed=${!!configObj}, genre=${args.extra?.genre}, search=${args.extra?.search}`);
    if (!configObj) return { metas: [] };

    const ud = await ensureCache(config, configObj);
    if (!ud || !ud.channelMap) return { metas: [] };

    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const selectedGenre = args.extra?.genre?.replace(/-/g, ' ') || null;
    const selectedSearch = args.extra?.search?.toLowerCase() || null;

    const metas = [];
    for (const [chKey, channel] of ud.channelMap.entries()) {
        if (selectedGenre && channel.meta.group !== selectedGenre) continue;
        if (selectedSearch && !channel.meta.name.toLowerCase().includes(selectedSearch)) continue;

        const engineImage = `${rootUrl}/${config}/poster/${chKey}.png?t=${ud.lastUpdated}`;
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
builder.defineMetaHandler(async (args, req) => {
    const config = req.params.config;
    const id = args.id;
    const configObj = extractConfig(req);

    await ensureCache(config, configObj);
    const ud = userCaches.get(config);
    if (!ud || !ud.channelMap.has(id)) return { meta: {} };
    const channel = ud.channelMap.get(id);

    const rootUrl = `${req.protocol}://${req.get('host')}`;
    const engineImage = `${rootUrl}/${config}/poster/${encodeURIComponent(id)}.png?t=${ud.lastUpdated}`;
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
builder.defineStreamHandler(async (args, req) => {
    const config = req.params.config;
    const id = args.id;
    const configObj = extractConfig(req);

    await ensureCache(config, configObj);
    const ud = userCaches.get(config);
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
    res.json(addonInterface.getManifest());
});

app.get('/:config/catalog/:type/:id.json', (req, res, next) => {
    // Wrap to extract config and pass req for config parsing
    addonInterface.handleCatalog(req.params, req, (err, result) => {
        if (err) return next(err);
        res.json(result);
    });
});

app.get('/:config/catalog/:type/:id/:extra.json', (req, res, next) => {
    addonInterface.handleCatalog(req.params, req, (err, result) => {
        if (err) return next(err);
        res.json(result);
    });
});

app.get('/:config/meta/:type/:id.json', (req, res, next) => {
    addonInterface.handleMeta(req.params, req, (err, result) => {
        if (err) return next(err);
        res.json(result);
    });
});

app.get('/:config/stream/:type/:id.json', (req, res, next) => {
    addonInterface.handleStream(req.params, req, (err, result) => {
        if (err) return next(err);
        res.json(result);
    });
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
const PORT = process.env.PORT || 3000;
startIptvOrgRefresh();

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
            const configObj = extractConfig({ params: { config: configKey }, query: {} });
            if (configObj) {
                console.log(`[ProactiveRefresh] refreshing stale config=${configKey.substring(0,12)}...`);
                streamFetchIPTV(configKey, configObj).catch(e => console.error('[ProactiveRefresh] failed:', e.message));
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
        }
    }
    console.log(`[Boot] Pre-warmed ${keys.length} config(s) from Redis.`);
})();

app.listen(PORT, () => console.log(`IPTVo Premium Backend operational on port ${PORT}`));