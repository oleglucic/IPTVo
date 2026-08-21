const axios = require('axios');
const readline = require('readline');
const zlib = require('zlib');
const sax = require('sax');
const { Readable } = require('stream');
const { startAiQueue } = require('./aiCurator');
const { getAllOverrides } = require('./db');
const { extractM3uCatchupInfo, extractXtreamCatchupInfo } = require('./catchup');
const { lookupChannel, lookupChannelFuzzy, lookupChannelSmart, isValidCountryCode, resolveGroupScope } = require('./iptvOrgRef');
const { configKeyFingerprint } = require('./cryptoUtils');

/**
 * Sanitizes a string for safe logging (prevents log injection).
 * Removes newlines, tabs, carriage returns, and limits length.
 * @param {string} str - The string to sanitize
 * @returns {string} - Sanitized string safe for logging
 */
function sanitizeForLog(str) {
    if (!str) return '';
    return String(str)
        .replace(/[\r\n\t]/g, '?')
        .replace(/[^\x20-\x7E]/g, '?')  // Keep only printable ASCII
        .substring(0, 200);  // Limit length
}

/**
 * Selects genres from iptv-org categories when the playlist group is generic; otherwise uses the playlist group.
 * @param {Object} iptvOrgMatch - The iptv-org match, including available categories.
 * @param {string} group - The playlist group label.
 * @returns {string[]} The selected genre labels.
 */
function pickGenres(iptvOrgMatch, group) {
    const cats = iptvOrgMatch && iptvOrgMatch.categories && iptvOrgMatch.categories.length ? iptvOrgMatch.categories : null;
    const g = (group || '').trim();
    const generic = !g || /^uncategorized$/i.test(g) || /^\s*$/.test(g);
    if (generic && cats) return cats;
    return [g || 'Uncategorized'];
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

/**
 * Re-validates the URL an axios response actually landed on. isSafeUrl() checks
 * only the requested URL; a redirect can bounce the fetch to a private/loopback,
 * link-local or cloud-metadata host on a public server. If a stream is being
 * consumed it is destroyed so an under-read response is not leaked.
 */
function revalidateResponseUrl(res, stream) {
    const resNode = res && res.request && res.request.res;
    const finalUrl = (res && res.responseUrl) || (resNode && resNode.responseUrl) || (res && res.config && res.config.url);
    if (finalUrl && !isSafeUrl(finalUrl)) {
        if (stream && typeof stream.destroy === 'function') stream.destroy();
        throw new Error("Redirect target is not allowed: private/internal addresses not allowed");
    }
}

// --- Synonym normalization (jr/junior etc) ---
const SYNONYM_MAP = { jr: 'junior' };
/**
 * Replaces configured word synonyms in a string.
 * @param {string} str - The text whose words should be normalized.
 * @return {string} The text with recognized synonyms replaced.
 */
function applySynonyms(str) {
    return str.split(/\s+/).map(w => SYNONYM_MAP[w.toLowerCase()] || w).join(' ');
}
const { saveCacheToRedis, saveLogoUrl } = require('./redisCache');
const { getLogoUrl, setLogoUrl } = require('./db');

// EPG refresh cadence is driven by the source's coverage span (task #42):
//   cover / 3  →  when to re-fetch, clamped to [30min, 12h].
// A feed that only covers a few hours is re-fetched often; a week-long feed
// less so. Empty/failed feeds retry soon (5min) until obtained.
const EPG_REFRESH_MIN = 30 * 60 * 1000;
const EPG_REFRESH_MAX = 12 * 60 * 60 * 1000;
const EPG_RETRY_FAIL = 5 * 60 * 1000;

const userCaches = new Map();
const MAX_CACHE_AGE = 60 * 60 * 1000; // 1 hour

// Tiered cache refresh (task #42): a failed refresh must never leave an empty
// catalog. On a parse error we preserve the last good snapshot and back off
// retrying exponentially so a down provider isn't hammered by every request.
// The entry is served (data) immediately; refresh resumes once retryAt passes.
const CACHE_BACKOFF_MIN = 60 * 1000;       // 1 min
const CACHE_BACKOFF_MAX = 30 * 60 * 1000;  // 30 min
const backoffAttempts = new Map(); // configKey -> consecutive failure count

// Coalesce concurrent cold starts for the same configKey, and cap total
// simultaneous provider parses so a wave of new users (hundreds of distinct
// configs) queues instead of stampeding the box.
const parseInFlight = new Map(); // configKey -> Promise (already-running parse)
let activeParses = 0;
// Concurrent provider parses. 4 is deliberately conservative so a wave of
// cold-start requests can't saturate a small box; on a larger host, operators
// can raise it via env to cut cold-start queue time for a bigger userbase.
const MAX_CONCURRENT_PARSES = parseInt(process.env.MAX_CONCURRENT_PARSES || '4', 10) || 4;
/**
 * Waits for an available parsing slot and reserves it.
 */
async function semaphoreSlot() {
    while (activeParses >= MAX_CONCURRENT_PARSES) {
        await new Promise(r => setTimeout(r, 200));
    }
    activeParses++;
}

/**
 * Coordinates parsing so concurrent requests for the same configuration share one in-flight operation.
 * @param {string} configKey - The identifier used to group equivalent parse requests.
 * @param {Object} configObj - The configuration passed to the parser.
 * @param {Function} parseFn - The parser to execute when no matching operation is in progress.
 * @return {*} The result produced by the parser.
 */
async function parseWithCoalescing(configKey, configObj, parseFn) {
    const existing = parseInFlight.get(configKey);
    if (existing) return existing;
    const promise = (async () => {
        await semaphoreSlot();
        try {
            return await parseFn(configKey, configObj);
        } finally {
            activeParses--;
        }
    })();
    parseInFlight.set(configKey, promise);
    try {
        return await promise;
    } finally {
        parseInFlight.delete(configKey);
    }
}

/**
 * Retrieves the cached IPTV data for a configuration.
 * @param {string} configKey - The configuration key identifying the cache entry.
 * @return {object|null} The cached data, or `null` when no entry exists.
 */
function getUserCache(configKey) {
    // Never evict a cache for staleness: an old-but-usable snapshot still beats
    // an empty catalog when the provider is down. Refresh decisions and retry
    // backoff live in streamFetchIPTV/ensureCache, not here.
    return userCaches.get(configKey) || null;
}

/**
 * Converts an XMLTV timestamp into Unix time in milliseconds.
 * @param {string} x - The XMLTV timestamp, including an optional timezone offset.
 * @return {number} The timestamp in Unix milliseconds, or `0` for invalid input.
 */
function parseXMLDate(x) {
    if (!x || x.length < 14) return 0;
    try {
        const offset = x.substring(15).trim() || '+0000';
        const fOffset = offset.length === 5 ? `${offset.substring(0,3)}:${offset.substring(3,5)}` : 'Z';
        const isoStr = `${x.substring(0,4)}-${x.substring(4,6)}-${x.substring(6,8)}T${x.substring(8,10)}:${x.substring(10,12)}:${x.substring(12,14)}${fOffset}`;
        const time = new Date(isoStr).getTime();
        if (isNaN(time)) return 0;
        return time;
    } catch (__e) {
        return 0;
    }
}

function normaliseFormat(str) {
    if (!str) return "";
    const map = {
        'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i','ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ǫ':'q','ʀ':'r','s':'s','ꜱ':'s','ᴛ':'t','ᴜ':'u','ᴠ':'v','ᴡ':'w','x':'x','ʏ':'y','ᴢ':'z',
        '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
        'ᵃ':'a','ᵇ':'b','ᶜ':'c','ᵈ':'d','ᵉ':'e','ᶠ':'f','ᵍ':'g','ʰ':'h','ⁱ':'i','ʲ':'j','ᵏ':'k','ˡ':'l','ᵐ':'m','ⁿ':'n','ᵒ':'o','ᵖ':'p','ʳ':'r','ˢ':'s','ᵗ':'t','ᵘ':'u','ᵛ':'v','ʷ':'w','ˣ':'x','ʸ':'y','ᶻ':'z',
        'ᴬ':'a','ᴮ':'b','ᶜ':'c','ᴰ':'d','ᴱ':'e','ᶠ':'f','ᴳ':'g','ᴴ':'h','ᴵ':'i','ᴶ':'j','ᴷ':'k','ᴸ':'l','ᴹ':'m','ᴺ':'n','ᴼ':'o','ᴾ':'p','ᴿ':'r','ˢ':'s','ᵀ':'t','ᵁ':'u','ⱽ':'v','ᵂ':'w',
        '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9',
        'ₐ':'a','ₑ':'e','ₕ':'h','ᵢ':'i','ⱼ':'j','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₚ':'p','ₛ':'s','ₜ':'t','ᵤ':'u','ᵥ':'v','ₓ':'x',
        'ⓐ':'a','Ⓐ':'a','ａ':'a','Ａ':'a','ⓑ':'b','Ⓑ':'b','ｂ':'b','Ｂ':'b','ⓒ':'c','Ⓒ':'c','ｃ':'c','Ｃ':'c','ⓓ':'d','Ⓓ':'d','ｄ':'d','Ｄ':'d','ⓔ':'e','Ⓔ':'e','ｅ':'e','Ｅ':'e',
        'ⓕ':'f','Ⓕ':'f','ｆ':'f','Ｆ':'f','ⓖ':'g','Ⓖ':'g','ｇ':'g','Ｇ':'g','ⓗ':'h','Ⓗ':'h','ｈ':'h','Ｈ':'h','ⓘ':'i','Ⓘ':'i','ｉ':'i','Ｉ':'i','ⓙ':'j','Ⓙ':'j','ｊ':'j','Ｊ':'j',
        'ⓚ':'k','Ⓚ':'k','ｋ':'k','Ｋ':'k','ⓛ':'l','Ⓛ':'l','ｌ':'l','Ｌ':'l','ⓜ':'m','Ⓜ':'m','ｍ':'m','Ｍ':'m','ⓝ':'n','Ⓝ':'n','ｎ':'n','Ｎ':'n','ⓞ':'o','Ⓞ':'o','ｏ':'o','Ｏ':'o',
        'ⓟ':'p','Ⓟ':'p','ｐ':'p','Ｐ':'p','ⓠ':'q','Ⓠ':'q','ｑ':'q','Ｑ':'q','ⓡ':'r','Ⓡ':'r','ｒ':'r','Ｒ':'r','ⓢ':'s','Ⓢ':'s','ｓ':'s','Ｓ':'s','ⓣ':'t','Ⓣ':'t','ｔ':'t','Ｔ':'t',
        '<b>':'','</b>':'','🇺':'u','Ⓤ':'u','ⓥ':'v','Ⓥ':'v','ｖ':'v','Ｖ':'v','ⓦ':'w','Ⓦ':'w','ｗ':'w','裝':'w','ⓧ':'x','Ⓧ':'x','ｘ':'x','Ｘ':'x','ⓨ':'y','Ⓨ':'y','ｙ':'y','Ｙ':'y',
        'ⓩ':'z','Ⓩ':'z','ｚ':'z','Ｚ':'z'
    };
    return str.split('').map(c => map[c] || c).join('');
}

/**
 * Classifies a stream name by quality and supported stream attributes.
 * @param {string} n - The stream name or description to classify.
 * @return {{name: string, title: string, score: number}} The quality label, attribute title, and ranking score.
 */
function parseStreamInfo(n) {
    const norm = normaliseFormat(n).toLowerCase();
    const cleanN = " " + norm.replace(/[^a-z0-9]/g, " ") + " ";
    
    let name = "HD";
    let score = 50000;
    
    if (cleanN.includes(" 8k ")) { name = "8K"; score = 80000; }
    else if (cleanN.includes(" 4k ") || cleanN.includes(" uhd ") || /\s2160[pi]\s/.test(cleanN) || /\s3180[pi]\s/.test(cleanN)) { name = "4K"; score = 70000; }
    else if (cleanN.includes(" fhd ") || cleanN.includes(" 1080p ") || cleanN.includes(" 1080i ")) { name = "FHD"; score = 60000; }
    else if (cleanN.includes(" hd ") || cleanN.includes(" 720p ")) { name = "HD"; score = 50000; }
    else if (cleanN.includes(" sd ") || cleanN.includes(" 576p ") || cleanN.includes(" 480p ")) { name = "SD"; score = 40000; }
    
    const e = [];
    if (cleanN.includes(" raw ")) { e.push("RAW"); score += 600; }
    if (cleanN.includes(" vip ")) { e.push("VIP"); score += 500; }
    if (cleanN.includes(" hevc ") || cleanN.includes(" h265 ")) { e.push("HEVC"); score += 400; }
    
    if (norm.includes("dolbyvision") || norm.includes("dolby vision") || norm.includes("dovi") || cleanN.includes(" dv ")) {
        e.push("Dolby Vision"); score += 350;
    }
    
    if (norm.includes("atmos")) {
        e.push("Dolby Atmos"); score += 300;
    } else if (norm.includes("dolby") || cleanN.includes(" ac3 ") || cleanN.includes(" eac3 ") || norm.includes("dd5") || norm.includes("audio")) {
        if (!e.includes("Dolby Vision")) { e.push("Dolby Audio"); score += 200; }
    }
    
    if (cleanN.includes(" 60fps ") || cleanN.includes(" 60 fps ")) { e.push("60FPS"); score += 300; }
    if (cleanN.includes(" 50fps ") || cleanN.includes(" 50 fps ")) { e.push("50FPS"); score += 200; }
    if (cleanN.includes(" 24 7 ") || cleanN.includes(" 247 ")) e.push("24/7");
    if (cleanN.includes(" backup ") || cleanN.includes(" alt ")) { e.push("ALT LINK"); score -= 25000; }
    
    return { name, title: e.length > 0 ? e.join(" • ") : "Direct Stream", score };
}

/**
 * Refreshes and parses an IPTV source while honoring cache freshness and retry backoff.
 * @param {string} configKey - Unique key identifying the IPTV configuration.
 * @param {Object} configObj - IPTV source configuration.
 * @return {*} The result of parsing the IPTV source.
 */
async function streamFetchIPTV(configKey, configObj) {
    const now = Date.now();
    if (userCaches.has(configKey)) {
        const existing = userCaches.get(configKey);
        if (existing.status === 'loading') return;
        // An errored entry carries the last good snapshot; don't refresh while
        // its backoff window is open (the provider is likely still down and
        // every request would otherwise hammer it).
        if (existing.status === 'error' && now < (existing.retryAt || 0)) return;
        if (existing.status === 'ready' && (now - existing.lastUpdated < MAX_CACHE_AGE)) return;
    }

    // Cold start OR refresh. On a refresh, seed the 'loading' entry with the
    // last good snapshot so a failure mid-parse can fall back to it in the
    // catch (serve-last-good) instead of the empty placeholder being preserved.
    const prevEntry = userCaches.get(configKey);
    const prior = (prevEntry && prevEntry.status !== 'loading') ? prevEntry : null;
    userCaches.set(configKey, {
        status: 'loading',
        channelMap: (prior && prior.channelMap) || new Map(),
        logoTracker: (prior && prior.logoTracker) || new Map(),
        catalogItems: (prior && prior.catalogItems) || [],
        uniqueGroups: (prior && prior.uniqueGroups) || new Set(),
        epgData: (prior && prior.epgData) || {},
        lastUpdated: (prior && prior.lastUpdated) || now
    });

    const parseFn = configObj && configObj.type === 'xtream' ? parseXtreamData : parseM3uData;
    const result = await parseWithCoalescing(configKey, configObj, parseFn);
    // Full parse succeeded → clear this config's failure backoff.
    backoffAttempts.delete(configKey);
    return result;
}

/**
 * Parses an M3U playlist and stores its channels, streams, logos, groups, and EPG data in the user cache.
 * @param {string} configKey - The key identifying the playlist configuration and its cache entry.
 * @param {Object} configObj - Playlist settings, including the M3U source and optional filtering, EPG, matching, and AI options.
 */
async function parseM3uData(configKey, configObj) {
    const __t0 = Date.now();
    console.log(`[parseM3uData] START for configKey=${configKeyFingerprint(configKey)}...`);
    const __overridesRows = await getAllOverrides();
    const overridesMap = new Map(__overridesRows.map(o => [o.raw_name, { canonical_id: o.canonical_id, confidence: parseFloat(o.confidence) }]));
    console.log(`[parser] Preloaded ${sanitizeForLog(overridesMap.size)} override mappings from DB`);
    try {
        if (!configObj) throw new Error("Configuration context object is missing.");
        const m3uTargetUrl = configObj.m3uUrl || configObj.m3u;

        // Test-only hook: allow a harness to feed inline M3U content without a
        // network fetch. Gated on an env var that is never set in production, so
        // real deployments still enforce isSafeUrl on every remote URL.
        let mStream = null;
        if (process.env.IPTVO_ALLOW_INLINE_M3U === '1' && typeof configObj.m3uContent === 'string') {
            mStream = Readable.from([configObj.m3uContent]);
        } else {
            if (!m3uTargetUrl) throw new Error("No M3U Playlist link found inside payload parameters.");
            // Prevent SSRF: validate URL before fetching
            if (!isSafeUrl(m3uTargetUrl)) {
                throw new Error("Invalid M3U URL: private/internal addresses not allowed");
            }
            const res = await axios({ method: 'get', url: m3uTargetUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 600000 }); // 10 min for large playlists
            revalidateResponseUrl(res, res.data);
            mStream = res.data;
            if (res.headers['content-encoding'] === 'gzip' || m3uTargetUrl.toLowerCase().endsWith('.gz')) mStream = mStream.pipe(zlib.createGunzip());
        }
        const rl = readline.createInterface({ input: mStream, crlfDelay: Infinity });
        
        const tMap = new Map(), logoTrack = new Map(), tCat = []; 
        const groups = new Set(), epgMap = new Map(); 
        const dirtyChannels = [];
        let cItem = null;
        
        for await (const line of rl) {
            const t = line.trim();
            if (t.startsWith('#EXTINF:')) {
                if (t.match(/\.(mp4|mkv)$/i) || t.includes('/movie/') || t.includes('/series/')) { cItem = null; continue; }
                
                const grp = t.match(/group-title=["']([^"']+)["']/i);
                let rawGrp = grp ? grp[1].trim() : 'Uncategorized';

                const filterGroups = (configObj.include || []).map(g => g.toLowerCase());
                const excludeGroups = (configObj.exclude || []).map(g => g.toLowerCase());
                const rawGrpLower = rawGrp.toLowerCase();

                if (filterGroups.length > 0) {
                    if (!filterGroups.includes(rawGrpLower)) { cItem = null; continue; }
                } else if (excludeGroups.length > 0) {
                    if (excludeGroups.includes(rawGrpLower)) { cItem = null; continue; }
                }

                const tvgId = t.match(/tvg-id=["']([^"']+)["']/i);
                const tvgName = t.match(/tvg-name=["']([^"']+)["']/i);
                const logo = t.match(/tvg-logo=["']([^"']+)["']/i);
                const catchupInfo = extractM3uCatchupInfo(t);
                const rawName = t.lastIndexOf(',') !== -1 ? t.substring(t.lastIndexOf(',') + 1).trim() : "Unknown";
                
                if (/([#\-\*_=\+~]){3,}/.test(rawName) || rawName.includes('----') || rawName.includes('####')) { cItem = null; continue; }
                
                const gScope = resolveGroupScope(rawGrp);
                let normGrp = gScope.rest.toLowerCase();
                let countryPrefix = gScope.prefix;

                let cleanGrp = normGrp.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|h265|live|vod|vip|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps)\b/gi, ' ');
                cleanGrp = cleanGrp.replace(/[-\/|:_\s]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                let finalGrp = countryPrefix + cleanGrp;
                if (!cleanGrp || cleanGrp.length < 2) finalGrp = rawGrp;
                const groupTagInfo = parseStreamInfo(rawGrp);
                const groupTags = groupTagInfo.title !== "Direct Stream" ? groupTagInfo.title : null;
                
                let cleanNameStr = normaliseFormat(rawName).toLowerCase();
const timeshiftMatch = cleanNameStr.match(/\+\s*(\d+)\b/);
const timeshiftSuffix = timeshiftMatch ? `_plus${timeshiftMatch[1]}` : '';
let cName = cleanNameStr.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|h265|vod|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|vip|live|backup|alt|online)\b/gi, ' ');
                // ReDoS-safe: use specific character classes without nested quantifiers
                cName = cName.replace(/\b24\s*[\/_\-]?\s*7\b/gi, ' ');
                cName = cName.replace(/\b\d+[pi]\b/gi, ' ');
                cName = cName.replace(/\b\d+\s*fps\b/gi, ' ');
                // Fixed: removed nested quantifier \s* followed by character class with *
                // Extract a leading 2-3 letter country code BEFORE stripping it, so
                // "usa espn" scopes to 'us' (and matches ESPN.us, not ESPN.au).
                let nameCountry = null;
                const ncMatch = cleanNameStr.match(/^([a-z]{2,3})\b\s*[-:|_\/\\|]*/i);
                if (ncMatch && isValidCountryCode(ncMatch[1])) {
                    nameCountry = ncMatch[1].toLowerCase();
                }
                cName = cName.replace(/^[a-z]{2,3}\b\s*[-:|_\/\\|]*/gi, ' ');
                cName = cName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

                // The GROUP prefix (if any) is authoritative; otherwise infer from
                // the leading country word in the channel name ("usa espn" → us).
                const countryScopeKey = (countryPrefix ? countryPrefix.replace(/[^A-Z]/g, '').toLowerCase() : null) || nameCountry || 'global';
                const baseCleanName = applySynonyms(cName).replace(/[^a-z0-9]/g, "") || "unknown";

                // No 'iptv:' prefix - colons in IDs can break client URL parsing
                let cId = `${countryScopeKey}_${baseCleanName}${timeshiftSuffix}`;

                // DEBUG: Log first few channels to trace iptv-org matching
                // if (Math.random() < 0.01) {
                //     console.log(`[DEBUG] cId=${cId}, baseCleanName=${baseCleanName}, countryScopeKey=${countryScopeKey}, rawName=${rawName}`);
                // }

                // 1. Check iptv-org reference data first (authoritative source) using cleaned name
                // Only run iptv-org matching if explicitly enabled in config
                let iptvOrgMatch = null;
                if (configObj.iptvOrg) {
                    // Smart matcher: token/alias/subsequence-tolerant over the
                    // space-preserved cleaned name, so playlist quirks
                    // ("CNN Intl", "DW English") still resolve to the iptv-org id.
                    // lookupChannelSmart already runs the conservative fuse-fuzzy
                    // tier internally on token misses, so the OR-chain below must
                    // NOT call lookupChannelFuzzy again — that double-invokes the
                    // expensive fuzzy scan on every token-different name.
                    iptvOrgMatch = lookupChannelSmart(cName, countryScopeKey)
                        || lookupChannel(baseCleanName, countryScopeKey);
                }
                if (iptvOrgMatch) {
                    // Use iptv-org's official ID as the canonical identifier
                    cId = `${iptvOrgMatch.countryScopeKey || 'global'}_${iptvOrgMatch.officialId}${timeshiftSuffix}`;
                    // Queue is not needed for AI as we have an authoritative match
                } else {
                    // 2. Check Supabase Override DB if no iptv-org match
                    const dbMapping = overridesMap.get(rawName) || null;
                    if (dbMapping && dbMapping.confidence >= 0.5) {
                        cId = dbMapping.canonical_id;
                    } else {
                        // Queue for async background AI deduplication if not mapped or low confidence
                        dirtyChannels.push({ rawName, baseCleanName, cId, countryScopeKey });
                    }
                }

                // Debug: Track iptv-org match rate
                // cItem is created below; mItem at line 249 sets __iptvOrgMatch: !!iptvOrgMatch

                if (tvgId) epgMap.set(tvgId[1].toLowerCase().trim(), cId);
                if (tvgName) epgMap.set(tvgName[1].toLowerCase().trim(), cId);
                epgMap.set(rawName.toLowerCase().trim(), cId);
                epgMap.set(rawName.toLowerCase().replace(/\s+/g, ''), cId);
                // iptv-org guide feeds key programmes by the official channel id
                // (e.g. channel="cnn.us"). Our canonical cId embeds that id
                // (scope_officialId), so register the raw official id too — this
                // is the recovery path that lets an iptv-org-keyed XMLTV feed map
                // straight onto matched channels instead of falling through.
                if (iptvOrgMatch && iptvOrgMatch.officialId) {
                    const officialLower = iptvOrgMatch.officialId.toLowerCase().trim();
                    epgMap.set(officialLower, cId);
                    epgMap.set(officialLower.replace(/\s+/g, ''), cId);
                }
                epgMap.set(cId, cId);
                
                let finalLogo = logo ? logo[1] : '';

                logoTrack.set(cId, { url: finalLogo, name: cName });
                // Store iptv-org logo separately for fallback chain
                const iptvOrgLogo = iptvOrgMatch ? iptvOrgMatch.logo : null;
                cItem = { cId, cName, rawName, logo: finalLogo, iptvOrgLogo, grp: finalGrp, groupTags, catchupInfo, iptvOrgMatch };

            } else if (t.startsWith('http') && cItem) {
                const { cId, cName, rawName, logo, iptvOrgLogo, grp, groupTags, catchupInfo, iptvOrgMatch } = cItem;
                const catId = `iptv_${grp.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
                groups.add(grp);

                if (!tMap.has(cId)) {
                    const displayName = iptvOrgMatch ? iptvOrgMatch.canonicalName : cName.replace(/\b\w/g, c => c.toUpperCase());
                    const displayLogo = iptvOrgMatch ? iptvOrgMatch.logo : logo;
                    const genres = pickGenres(iptvOrgMatch, grp);
                    const mItem = { id: cId, type: 'tv', name: displayName, genres, catalogId: catId, logo: displayLogo, fallbackLogo: iptvOrgLogo || logo, rawName: rawName, group: grp, groupTags: groupTags, hasCatchup: !!(catchupInfo && catchupInfo.hasCatchup), catchupDays: catchupInfo ? catchupInfo.catchupDays : 0, __iptvOrgMatch: !!iptvOrgMatch };
                    tMap.set(cId, { meta: mItem, streams: [] });
                    tCat.push(mItem);
                }
                
                const sInfo = parseStreamInfo(rawName);
                tMap.get(cId).streams.push({ name: sInfo.name, title: sInfo.title, url: t, score: sInfo.score, groupTags: groupTags }); 
                cItem = null;
            }
        }
        
        const epgCall = await handleXmltvEpg(configObj.epg, tMap, epgMap);
        let tEpg = (epgCall && epgCall.tEpg) || {};
        let epgCoverageMs = (epgCall && epgCall.spanMs) || 0;
        // iptv-org guide enrichment (#41): when iptv-org matching is enabled,
        // also merge in iptv-org guide programmes for matched channels (user's
        // own EPG feed wins on conflict). Only fills channels we can map.
        if (configObj.iptvOrg) {
            const enrich = await fetchIptvOrgEpg(configObj, epgMap);
            if (enrich && enrich.tEpg) {
                epgCoverageMs = Math.max(epgCoverageMs, enrich.spanMs);
                tEpg = Object.assign(tEpg, enrich.tEpg);
            }
        }
        const epgLastUpdated = Date.now();
        const epgNextRefreshAt = epgScheduleNextRefresh(epgCoverageMs);

        // Log iptv-org match statistics
        let iptvOrgMatchCount = 0;
        for (const [, channel] of tMap.entries()) {
            if (channel.meta.__iptvOrgMatch) iptvOrgMatchCount++;
        }
        console.log(`[iptv-org] Matched ${sanitizeForLog(iptvOrgMatchCount)}/${sanitizeForLog(tMap.size)} channels (${tMap.size > 0 ? Math.round(iptvOrgMatchCount * 100 / tMap.size) : 0}%)`);

        userCaches.set(configKey, {
            status: 'ready', channelMap: tMap, logoTracker: logoTrack, catalogItems: tCat, uniqueGroups: groups, epgData: tEpg,
            epgMap, // retained for the decoupled EPG-only refresh
            epgLastUpdated, epgNextRefreshAt, epgCoverageMs,
            lastUpdated: Date.now()
        });
        console.log(`[parser] READY configKey=${configKeyFingerprint(configKey)}... channels=${sanitizeForLog(tMap.size)} groups=${sanitizeForLog(groups.size)} elapsed=${Date.now() - __t0}ms`);
        saveCacheToRedis(configKey, userCaches.get(configKey)).catch(e => console.error('[Redis Error] write-through failed:', sanitizeForLog(e.message)));

        // Save logo URLs to Redis for change detection (background, non-blocking)
        saveLogoUrlsToRedis(configKey, tMap).catch(e => console.error('[Logo URL Save Error]', sanitizeForLog(e.message)));

        // Queue background logo pre-fetch for channels without iptv-org match
        const missingLogos = [];
        for (const [, channel] of tMap.entries()) {
            if (!channel.meta.__iptvOrgMatch && channel.meta.logo) {
                missingLogos.push({
                    url: channel.meta.logo,
                    cId: channel.meta.id,
                    iptvOrgLogo: channel.meta.iptvOrgLogo
                });
            }
        }
        if (missingLogos.length > 0) {
            console.log(`[LogoPrefetch] Queuing ${sanitizeForLog(missingLogos.length)} logos for background fetch...`);
            queueLogoPrefetch(missingLogos).catch(e => console.error('[LogoPrefetch] Error:', sanitizeForLog(e.message)));
        }

        // Always trigger async background AI process when dirty channels exist
        if (dirtyChannels.length > 0 && configObj.openrouterKey) {
            console.log(`[AI Curator] Starting AI queue with openrouterKey for ${dirtyChannels.length} dirty channels`);
            startAiQueue(dirtyChannels, configKey, configObj.openrouterKey, configObj.aiModel).catch(err => console.error("[AI Queue Error]", sanitizeForLog(err.message)));
        } else if (dirtyChannels.length > 0) {
            console.log(`[AI Curator] Skipping - OpenRouter API key not provided in config. Config keys: ${sanitizeForLog(Object.keys(configObj).join(', '))}, ai=${sanitizeForLog(configObj.ai)}`);
        }

    } catch(e) {
        // Serve last good: preserve the previous snapshot (channels, catalog,
        // groups, EPG) so a failed refresh degrades to stale-but-working data
        // instead of an empty catalog. Retry with exponential backoff so a down
        // provider isn't re-fetched on every request.
        const prev = userCaches.get(configKey);
        const attempts = (backoffAttempts.get(configKey) || 0) + 1;
        backoffAttempts.set(configKey, attempts);
        console.error(`[parser] ERROR configKey=${configKeyFingerprint(configKey)}... message=${sanitizeForLog(e.message)} elapsed=${Date.now() - __t0}ms backoffAttempt=${sanitizeForLog(attempts)}`);
        userCaches.set(configKey, {
            status: 'error',
            channelMap: (prev && prev.channelMap) || new Map(),
            logoTracker: (prev && prev.logoTracker) || new Map(),
            catalogItems: (prev && prev.catalogItems) || [],
            uniqueGroups: (prev && prev.uniqueGroups) || new Set(),
            epgData: (prev && prev.epgData) || {},
            lastUpdated: (prev && prev.lastUpdated) || 0, // keeps old clock so staleness grows naturally
            message: sanitizeForLog(e.message),
            retryAt: Date.now() + Math.min(CACHE_BACKOFF_MIN * (2 ** (attempts - 1)), CACHE_BACKOFF_MAX),
        });
    }
}

/**
 * Loads, normalizes, and caches live channel data from an Xtream server, including stream metadata and EPG information.
 * @param {string} configKey - The key identifying the configuration and its cache entry.
 * @param {Object} configObj - Xtream connection, filtering, EPG, and enrichment configuration.
 */
async function parseXtreamData(configKey, configObj) {
    const __t0 = Date.now();
    console.log(`[parseXtreamData] START for configKey=${configKeyFingerprint(configKey)}...`);
    const __overridesRows = await getAllOverrides();
    const overridesMap = new Map(__overridesRows.map(o => [o.raw_name, { canonical_id: o.canonical_id, confidence: parseFloat(o.confidence) }]));
    console.log(`[parser] Preloaded ${sanitizeForLog(overridesMap.size)} override mappings from DB`);
    try {
        if (!configObj) throw new Error("Configuration mapping context payload is missing.");

        const rawUrl = configObj.xtreamUrl || configObj.host || "";
        if (!rawUrl) throw new Error("Xtream target base Server URL string parameter was undefined.");

        const baseUrl = rawUrl.endsWith('/') ? rawUrl.slice(0, -1) : rawUrl;
        const user = configObj.username || configObj.user || "";
        const pass = configObj.password || configObj.pass || "";
        const epg = configObj.epg;

        // Prevent SSRF: validate base URL before making API calls
        if (!isSafeUrl(baseUrl)) {
            throw new Error("Invalid Xtream URL: private/internal addresses not allowed");
        }

        const apiBase = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

        console.log(`[Xtream Engine] Querying data channels from endpoint: ${sanitizeForLog(baseUrl)}`);

        const [catRes, streamRes] = await Promise.all([
            axios.get(`${apiBase}&action=get_live_categories`, { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => ({ data: [] })),
            axios.get(`${apiBase}&action=get_live_streams`, { timeout: 90000, headers: { 'User-Agent': 'Mozilla/5.0' } })
        ]);

        revalidateResponseUrl(streamRes);
        revalidateResponseUrl(catRes);

        if (!streamRes.data || !Array.isArray(streamRes.data)) {
            throw new Error("Invalid stream response payload from Xtream server.");
        }

        const catMap = new Map();
        if (Array.isArray(catRes.data)) {
            catRes.data.forEach(item => {
                if (item.category_id && item.category_name) {
                    catMap.set(item.category_id.toString(), item.category_name.trim());
                }
            });
        }

        const tMap = new Map(), logoTrack = new Map(), tCat = [];
        const groups = new Set(), epgMap = new Map();
        const dirtyChannels = [];

        for (const stream of streamRes.data) {
            if (stream.stream_type !== 'live' || !stream.stream_id) continue;
            const catchupInfo = extractXtreamCatchupInfo(stream);

            const rawGrp = catMap.get(stream.category_id?.toString()) || 'Uncategorized';

            const filterGroups = (configObj.include || []).map(g => g.toLowerCase());
            const excludeGroups = (configObj.exclude || []).map(g => g.toLowerCase());
            const rawGrpLower = rawGrp.toLowerCase();

            if (filterGroups.length > 0) {
                if (!filterGroups.includes(rawGrpLower)) continue;
            } else if (excludeGroups.length > 0) {
                if (excludeGroups.includes(rawGrpLower)) continue;
            }

            const rawName = stream.name || "Unknown Channel";
            if (/([#\-\*_=\+~]){3,}/.test(rawName) || rawName.includes('----') || rawName.includes('####')) continue;

            const gScope = resolveGroupScope(rawGrp);
            let normGrp = gScope.rest.toLowerCase();
            let countryPrefix = gScope.prefix;

            let cleanGrp = normGrp.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|h265|live|vod|vip|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps)\b/gi, ' ');
            cleanGrp = cleanGrp.replace(/[-\/|:_\s]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
            let finalGrp = countryPrefix + cleanGrp;
            if (!cleanGrp || cleanGrp.length < 2) finalGrp = rawGrp;
            const groupTagInfo = parseStreamInfo(rawGrp);
            const groupTags = groupTagInfo.title !== "Direct Stream" ? groupTagInfo.title : null;

            let cleanNameStr = normaliseFormat(rawName).toLowerCase();
const timeshiftMatch = cleanNameStr.match(/\+\s*(\d+)\b/);
const timeshiftSuffix = timeshiftMatch ? `_plus${timeshiftMatch[1]}` : '';
let cName = cleanNameStr.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|h265|vod|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|vip|live|backup|alt|online)\b/gi, ' ');
            // ReDoS-safe: use specific character classes without nested quantifiers
            cName = cName.replace(/\b24\s*[\/_\-]?\s*7\b/gi, ' ');
            cName = cName.replace(/\b\d+[pi]\b/gi, ' ');
            cName = cName.replace(/\b\d+\s*fps\b/gi, ' ');
            // Fixed: removed nested quantifier \s* followed by character class with *
            cName = cName.replace(/^[a-z]{2,3}\b\s*[-:|_\/\\|]*/gi, ' ');
            cName = cName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

            // Group prefix wins; else infer from a leading country word in the name.
            const nameCountry = (cleanNameStr.match(/^([a-z]{2,3})\b\s*[-:|_\/\\|]*/i) || [])[1];
            const countryScopeKey = (countryPrefix ? countryPrefix.replace(/[^A-Z]/g, '').toLowerCase() : null)
                || (nameCountry && isValidCountryCode(nameCountry) ? nameCountry.toLowerCase() : null)
                || 'global';
            const baseCleanName = applySynonyms(cName).replace(/[^a-z0-9]/g, "") || "unknown";
            
            // No 'iptv:' prefix - colons in IDs can break client URL parsing
            let cId = `${countryScopeKey}_${baseCleanName}${timeshiftSuffix}`;

            // 1. Check iptv-org reference data first (authoritative source) using cleaned name
            // Only run iptv-org matching if explicitly enabled in config
            let iptvOrgMatch = null;
            if (configObj.iptvOrg) {
                // lookupChannelSmart already runs the conservative fuse-fuzzy tier
                // internally on token misses; do NOT re-invoke lookupChannelFuzzy
                // here (it double-scans the whole fuse index on every non-token name).
                iptvOrgMatch = lookupChannelSmart(cName, countryScopeKey)
                    || lookupChannel(baseCleanName, countryScopeKey);
            }
            if (iptvOrgMatch) {
                // Use iptv-org's official ID as the canonical identifier
                cId = `${iptvOrgMatch.countryScopeKey || 'global'}_${iptvOrgMatch.officialId}${timeshiftSuffix}`;
            } else {
                // 2. Check Supabase Override DB if no iptv-org match
                const dbMapping = overridesMap.get(rawName) || null;
                if (dbMapping && dbMapping.confidence >= 0.5) {
                    cId = dbMapping.canonical_id;
                } else {
                    // Queue for async background AI deduplication if not mapped or low confidence
                    dirtyChannels.push({ rawName, baseCleanName, cId, countryScopeKey });
                }
            }

            if (stream.epg_channel_id) epgMap.set(stream.epg_channel_id.toLowerCase().trim(), cId);
            epgMap.set(rawName.toLowerCase().trim(), cId);
            epgMap.set(cId, cId);
            // iptv-org guide feeds key programmes by the official channel id
            // (channel="cnn.us"). Register the raw id so such a feed maps onto
            // the matched canonical channel instead of falling through.
            if (iptvOrgMatch && iptvOrgMatch.officialId) {
                const officialLower = iptvOrgMatch.officialId.toLowerCase().trim();
                epgMap.set(officialLower, cId);
                epgMap.set(officialLower.replace(/\s+/g, ''), cId);
            }

            let finalLogo = stream.stream_icon || '';

            logoTrack.set(cId, { url: finalLogo, name: cName });
            // Store iptv-org logo separately for fallback chain
            const iptvOrgLogo = iptvOrgMatch ? iptvOrgMatch.logo : null;

            const catId = `iptv_${finalGrp.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
            groups.add(finalGrp);

            if (!tMap.has(cId)) {
                const displayName = iptvOrgMatch ? iptvOrgMatch.canonicalName : cName.replace(/\b\w/g, c => c.toUpperCase());
                const displayLogo = iptvOrgMatch ? iptvOrgMatch.logo : finalLogo;
                const genres = pickGenres(iptvOrgMatch, finalGrp);
                const mItem = { id: cId, type: 'tv', name: displayName, genres, catalogId: catId, logo: displayLogo, fallbackLogo: iptvOrgLogo || finalLogo, rawName: rawName, group: finalGrp, groupTags: groupTags, hasCatchup: !!(catchupInfo && catchupInfo.hasCatchup), catchupDays: catchupInfo ? catchupInfo.catchupDays : 0, __iptvOrgMatch: !!iptvOrgMatch };
                tMap.set(cId, { meta: mItem, streams: [] });
                tCat.push(mItem);
            }

            const sInfo = parseStreamInfo(rawName);
            const liveStreamUrl = `${baseUrl}/live/${user}/${pass}/${stream.stream_id}.ts`;
            
            tMap.get(cId).streams.push({ name: sInfo.name, title: sInfo.title, url: liveStreamUrl, score: sInfo.score, groupTags: groupTags });
        }

        const epgCall = await handleXmltvEpg(epg, tMap, epgMap);
        let tEpg = (epgCall && epgCall.tEpg) || {};
        let epgCoverageMs = (epgCall && epgCall.spanMs) || 0;
        if (configObj.iptvOrg) {
            const enrich = await fetchIptvOrgEpg(configObj, epgMap);
            if (enrich && enrich.tEpg) {
                epgCoverageMs = Math.max(epgCoverageMs, enrich.spanMs);
                tEpg = Object.assign(tEpg, enrich.tEpg);
            }
        }
        const epgLastUpdated = Date.now();
        const epgNextRefreshAt = epgScheduleNextRefresh(epgCoverageMs);

        // Log iptv-org match statistics
        let iptvOrgMatchCount = 0;
        for (const [, channel] of tMap.entries()) {
            if (channel.meta.__iptvOrgMatch) iptvOrgMatchCount++;
        }
        console.log(`[iptv-org] Matched ${sanitizeForLog(iptvOrgMatchCount)}/${sanitizeForLog(tMap.size)} channels (${tMap.size > 0 ? Math.round(iptvOrgMatchCount * 100 / tMap.size) : 0}%)`);

        userCaches.set(configKey, {
            status: 'ready', channelMap: tMap, logoTracker: logoTrack, catalogItems: tCat, uniqueGroups: groups, epgData: tEpg,
            epgMap, // retained for the decoupled EPG-only refresh
            epgLastUpdated, epgNextRefreshAt, epgCoverageMs,
            lastUpdated: Date.now()
        });
        console.log(`[parser] READY configKey=${configKeyFingerprint(configKey)}... channels=${sanitizeForLog(tMap.size)} groups=${sanitizeForLog(groups.size)} elapsed=${Date.now() - __t0}ms`);
        saveCacheToRedis(configKey, userCaches.get(configKey)).catch(e => console.error('[Redis Error] write-through failed:', sanitizeForLog(e.message)));
        console.log(`[Xtream Engine] Categorized and loaded ${sanitizeForLog(tCat.length)} streams inside memory.`);

        // Save logo URLs to Redis for change detection (background, non-blocking)
        saveLogoUrlsToRedis(configKey, tMap).catch(e => console.error('[Logo URL Save Error]', sanitizeForLog(e.message)));

        if (dirtyChannels.length > 0 && configObj.openrouterKey) {
            startAiQueue(dirtyChannels, configKey, configObj.openrouterKey, configObj.aiModel).catch(err => console.error("[AI Queue Error]", sanitizeForLog(err.message)));
        } else if (dirtyChannels.length > 0) {
            console.log(`[AI Curator] Skipping - OpenRouter API key not provided in config`);
        }

    } catch(e) {
        // Serve last good (same policy as parseM3uData): keep the previous
        // snapshot so a down Xtream panel shows stale-but-working channels.
        const prev = userCaches.get(configKey);
        const attempts = (backoffAttempts.get(configKey) || 0) + 1;
        backoffAttempts.set(configKey, attempts);
        console.error("[Xtream Engine Error]", sanitizeForLog(e.message));
        console.error(`[parser] ERROR configKey=${configKeyFingerprint(configKey)}... message=${sanitizeForLog(e.message)} elapsed=${Date.now() - __t0}ms backoffAttempt=${sanitizeForLog(attempts)}`);
        userCaches.set(configKey, {
            status: 'error',
            channelMap: (prev && prev.channelMap) || new Map(),
            logoTracker: (prev && prev.logoTracker) || new Map(),
            catalogItems: (prev && prev.catalogItems) || [],
            uniqueGroups: (prev && prev.uniqueGroups) || new Set(),
            epgData: (prev && prev.epgData) || {},
            lastUpdated: (prev && prev.lastUpdated) || 0,
            message: sanitizeForLog(e.message),
            retryAt: Date.now() + Math.min(CACHE_BACKOFF_MIN * (2 ** (attempts - 1)), CACHE_BACKOFF_MAX),
        });
    }
}

/**
 * Parses an XMLTV feed and maps programme schedules to known canonical channels.
 * @param {string} epgUrl - The XMLTV feed URL.
 * @param {Map} tMap - Map of known canonical channel IDs.
 * @param {Map} epgMap - Map of XMLTV channel identifiers to canonical channel IDs.
 * @return {{tEpg: Object, spanMs: number}} The channel programme mapping and its coverage span in milliseconds.
 */
async function handleXmltvEpg(epgUrl, tMap, epgMap) {
    const tEpg = {};
    if (!epgUrl) return { tEpg, spanMs: 0 };

    // Prevent SSRF: validate EPG URL before fetching
    if (!isSafeUrl(epgUrl)) {
        console.error('[handleXmltvEpg] Invalid EPG URL: private/internal addresses not allowed');
        return { tEpg, spanMs: 0 };
    }

    return new Promise(async (resolve) => {
        try {
            const epgRes = await axios({ method: 'get', url: epgUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 300000 });
            revalidateResponseUrl(epgRes, epgRes.data);
            let rawStream = epgRes.data;
            
            const firstChunk = await new Promise((resChunk) => { rawStream.once('data', (chunk) => resChunk(chunk)); });
            let finalizedStream;
            if (firstChunk && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b) {
                const combined = Readable.from((async function* () { yield firstChunk; for await (const chunk of rawStream) { yield chunk; } })());
                finalizedStream = combined.pipe(zlib.createGunzip());
            } else {
                finalizedStream = Readable.from((async function* () { if (firstChunk) yield firstChunk; for await (const chunk of rawStream) { yield chunk; } })());
            }

            // Using sax parser streaming to parse XML memory-safely
            const saxStream = sax.createStream(true, { trim: true, normalize: true });
            let currentProgramme = null;
            let currentText = '';

            saxStream.on('opentag', (node) => {
                if (node.name === 'programme') {
                    currentProgramme = {
                        start: parseXMLDate(node.attributes.start || ""),
                        stop: parseXMLDate(node.attributes.stop || ""),
                        channel: node.attributes.channel ? node.attributes.channel.toLowerCase().trim() : ""
                    };
                }
                currentText = '';
            });

            saxStream.on('text', (text) => {
                if (currentProgramme) {
                    currentText += text;
                }
            });

            saxStream.on('closetag', (tagName) => {
                if (currentProgramme) {
                    if (tagName === 'title') {
                        currentProgramme.title = currentText.trim();
                    } else if (tagName === 'desc') {
                        currentProgramme.desc = currentText.trim();
                    } else if (tagName === 'programme') {
                        const mId = epgMap.get(currentProgramme.channel) || epgMap.get(currentProgramme.channel.replace(/\s+/g, ''));
                        if (mId && tMap.has(mId)) {
                            if (!tEpg[mId]) tEpg[mId] = [];
                            tEpg[mId].push({
                                start: currentProgramme.start,
                                stop: currentProgramme.stop,
                                title: currentProgramme.title || "Unknown",
                                desc: currentProgramme.desc || ""
                            });
                        }
                        currentProgramme = null;
                    }
                }
            });

            // Coverage span over all parsed programmes — drives the EPG refresh
            // cadence (short feeds refresh more often, long feeds less so).
            let minStart = Infinity, maxStop = 0, progs = 0;
            for (const list of Object.values(tEpg)) {
                for (const p of list) {
                    progs++;
                    if (p.start < minStart) minStart = p.start;
                    if (p.stop > maxStop) maxStop = p.stop;
                }
            }
            const spanMs = progs > 0 ? (maxStop - minStart) : 0;
            resolve({ tEpg, spanMs });

            saxStream.on('error', (err) => {
                console.error('[EPG SAX Error]', sanitizeForLog(err.message));
                resolve({ tEpg, spanMs: 0 });
            });

            finalizedStream.pipe(saxStream);
        } catch(e) {
            console.error("EPG Error", sanitizeForLog(e.message));
            resolve({ tEpg, spanMs: 0 });
        }
    });
}

// --- iptv-org guide enrichment (#41) --------------------------------------
// The iptv-org API exposes guides.json (officialId → site_id + sources[]), but
// today almost no guide carries a ready-to-fetch XMLTV URL. We still leverage
// the map: where a channel has a direct URL source we fetch it and map its
// programmes onto matched channels via the retained epgMap; everything else
// simply falls back to the user's own EPG / "No TV guide". No per-site
// scraping, no fabricated feeds.
let iptvOrgGuideCache = null; // { byChannel: Map<officialId, [{url}]>, fetchedAt }
const IPTVORG_GUIDE_TTL = 24 * 60 * 60 * 1000;
const IPTVORG_GUIDE_URL = 'https://iptv-org.github.io/api/guides.json';

/**
 * Loads the iptv-org guide metadata indexed by channel identifier.
 * @return {Promise<Map<string, Array>>} A map of channel identifiers to usable guide metadata with direct HTTP(S) sources.
 */
async function loadIptvOrgGuideMap() {
    const now = Date.now();
    if (iptvOrgGuideCache && now - iptvOrgGuideCache.fetchedAt < IPTVORG_GUIDE_TTL) return iptvOrgGuideCache.byId;
    const byId = new Map();
    try {
        const res = await axios.get(IPTVORG_GUIDE_URL, { timeout: 30000, responseType: 'json' });
        const list = Array.isArray(res.data) ? res.data : [];
        for (const g of list) {
            const chanId = (g && g.channel) ? String(g.channel).toLowerCase().trim() : '';
            if (!chanId) continue;
            const urls = ((g && g.sources) || [])
                .map(s => s && s.url)
                .filter(u => typeof u === 'string' && u.startsWith('http'));
            if (urls.length === 0) continue; // only direct-URL guides are usable
            let arr = byId.get(chanId);
            if (!arr) { arr = []; byId.set(chanId, arr); }
            arr.push({ siteId: g.site_id || '', lang: g.lang || (g.sources && g.sources[0] && g.sources[0].lang) || '', urls });
        }
        iptvOrgGuideCache = { byId, fetchedAt: now };
        console.log(`[iptv-org] Guide map loaded: ${byId.size} channels with direct URL sources`);
    } catch (e) {
        console.error('[iptv-org] Guide map load failed:', sanitizeForLog(e.message));
    }
    return byId;
}

/**
 * Fetches and maps IPTV-org programme schedules for matched channels.
 * @param {Map} epgMap - Maps official IPTV-org channel identifiers to canonical channel IDs.
 * @return {{tEpg: Object, spanMs: number}|null} The mapped programme schedules and maximum coverage span, or `null` when IPTV-org enrichment is unavailable.
 */
async function fetchIptvOrgEpg(configObj, epgMap) {
    if (!configObj || !configObj.iptvOrg) return null;
    const guideByChannel = await loadIptvOrgGuideMap();
    if (!guideByChannel) return null;

    const tEpg = {};
    let maxSpan = 0;
    // Filter to matched channels (their officialId is registered in epgMap).
    for (const [officialId, cId] of epgMap.entries()) {
        const guides = guideByChannel.get(String(officialId).toLowerCase());
        if (!guides || guides.length === 0) continue;
        const url = guides[0].urls[0];
        if (!url) continue;
        try {
            // Map this channel's programmes onto the canonical channel id.
            const fakeMap = new Map([[officialId, cId]]);
            const res = await handleXmltvEpg(url, new Map(), fakeMap);
            const progs = res && res.tEpg ? res.tEpg[cId] : null;
            if (progs && progs.length) {
                tEpg[cId] = progs;
                if (res.spanMs > maxSpan) maxSpan = res.spanMs;
            }
        } catch (e) {
            // A single guide failure must not break the whole enrichment.
        }
    }
    if (!Object.keys(tEpg).length) return { tEpg, spanMs: 0 };
    return { tEpg, spanMs: maxSpan };
}

/** Map a parsed EPG programme-list span into a next-refresh timestamp (clamped). */
function epgScheduleNextRefresh(spanMs) {
    if (!spanMs || spanMs <= 0) return Date.now() + EPG_RETRY_FAIL; // empty/failed → retry soon
    return Date.now() + Math.min(Math.max(spanMs / 3, EPG_REFRESH_MIN), EPG_REFRESH_MAX);
}

/**
 * Refresh EPG data for a cached playlist entry without reloading its channels or streams.
 * @param {Object} entry - Cached entry containing EPG mappings and previously fetched data.
 * @param {Object} configObj - Configuration containing the EPG source and optional iptv-org enrichment.
 * @return {Promise<{epgData: Object, epgNextRefreshAt: number, epgCoverageMs: number}|null>} Refreshed EPG data, next refresh time, and coverage duration; `null` if no EPG source is configured.
 */
async function refreshEpgForEntry(entry, configObj) {
    if (!entry) return null;
    const epgUrl = configObj && (configObj.epg || configObj.epgUrl);
    const epgMap = entry.epgMap || new Map();
    if (!epgUrl && !(configObj && configObj.iptvOrg)) return null;

    let out = { epgData: entry.epgData || {}, epgNextRefreshAt: 0, epgCoverageMs: 0 };
    let span = 0;
    let tEpg = {};
    if (epgUrl) {
        const res = await handleXmltvEpg(epgUrl, new Map(), epgMap);
        tEpg = res && res.tEpg ? res.tEpg : {};
        span = res && res.spanMs ? res.spanMs : 0;
    }
    if (configObj && configObj.iptvOrg) {
        const enrich = await fetchIptvOrgEpg(configObj, epgMap);
        if (enrich && enrich.tEpg) {
            // merge: user feed wins on conflict (starts with user, add iptv-org)
            for (const [chId, progs] of Object.entries(tEpg)) if (!tEpg[chId]) tEpg[chId] = progs;
            span = span || (enrich.spanMs || 0);
            tEpg = Object.assign(tEpg, enrich.tEpg);
        }
    }
    if (span > 0) {
        out.epgData = tEpg;
        out.epgCoverageMs = span;
        out.epgNextRefreshAt = epgScheduleNextRefresh(span);
    } else {
        // keep last good data; retry soon
        out.epgNextRefreshAt = Date.now() + EPG_RETRY_FAIL;
    }
    return out;
}

/**
 * Formats the current and next scheduled programs for a channel.
 * @param {string} chKey - The channel identifier used to locate the schedule.
 * @param {Object} epgData - EPG schedules keyed by channel identifier.
 * @param {number} [offsetHours=0] - Number of hours to add to displayed times.
 * @return {string} Formatted programme information or a fallback message when no schedule is available.
 */
function getEpgText(chKey, epgData, offsetHours = 0) {
    const now = Date.now(), sched = epgData[chKey];
    if (!sched || sched.length === 0) return "No TV guide mapped.";
    const fProgs = sched.filter(p => p.stop > now).sort((a,b) => a.start - b.start);
    if (fProgs.length === 0) return "No upcoming programs mapped.";
    const cP = fProgs[0], nP = fProgs[1]; let text = "";

    const formatTime = (ms) => {
        const shiftedDate = new Date(ms + (parseInt(offsetHours) * 3600000));
        return `${String(shiftedDate.getUTCHours()).padStart(2, '0')}:${String(shiftedDate.getUTCMinutes()).padStart(2, '0')}`;
    };

    if (cP) text += `🟢 LATEST (${formatTime(cP.start)} - ${formatTime(cP.stop)})\n${cP.title}\n${cP.desc}\n\n`;
    if (nP) text += `⏭️ UP NEXT (${formatTime(nP.start)})\n${nP.title}`;
    return text;
}

/**
 * Persists primary channel logo URLs for change tracking.
 * @param {Map} tMap - Map of channel identifiers to channel metadata.
 */
async function saveLogoUrlsToRedis(configKey, tMap) {
    let saved = 0;
    for (const [cId, channel] of tMap.entries()) {
        const meta = channel.meta;
        // Use the primary logo URL for tracking
        if (meta.logo) {
            const source = meta.__iptvOrgMatch ? 'iptv-org' : 'playlist';
            // Save to Redis (fast, 30-day TTL)
            await saveLogoUrl(cId, meta.logo, source);
            // Save to Database (persistent, no expiry, only updates on URL change)
            await setLogoUrl(cId, meta.logo, source);
            saved++;
        }
    }
    if (saved > 0) {
        console.log(`[LogoCache] Saved ${sanitizeForLog(saved)} logo URLs for change tracking (Redis + DB)`);
    }
}

/**
 * Refreshes channel logos when their URLs are new, changed, or associated with a previous fetch failure.
 */
async function backgroundLogoRefresh() {
    console.log('[LogoRefresh] Starting background logo refresh...');
    let checked = 0;
    let refreshed = 0;
    let unchanged = 0;
    let errors = 0;

    try {
        for (const [_configKey, cached] of userCaches.entries()) {
            if (!cached || cached.status !== 'ready' || !cached.channelMap) continue;

            for (const [cId, channel] of cached.channelMap.entries()) {
                const meta = channel.meta;
                // Skip channels with no logo
                if (!meta.logo) continue;

                checked++;

                // Check stored URL in Database (persistent, no expiry)
                const stored = await getLogoUrl(cId);
                const currentUrl = meta.logo;

                if (stored && stored.url === currentUrl) {
                    // URL unchanged - logo likely the same, skip
                    unchanged++;
                    continue;
                }

                // URL changed or first time seeing this channel - need refresh
                console.log(`[LogoRefresh] Logo URL changed/new for ${sanitizeForLog(cId)}, refreshing...`);

                try {
                    // Fetch via imageEngine (which uses Worker proxy + Redis cache)
                    // Pass both primary (iptv-org) and fallback (playlist) logos for Worker fallback chain
                    const { getPremiumPoster } = require('./imageEngine');
                    const primaryLogo = meta.iptvOrgLogo || meta.logo;
                    const fallbackLogo = meta.iptvOrgLogo ? meta.logo : null;
                    await getPremiumPoster(cId, primaryLogo, fallbackLogo, meta.name);

                    // Update stored URL in Database (persistent)
                    await setLogoUrl(cId, currentUrl, meta.__iptvOrgMatch ? 'iptv-org' : 'playlist');
                    // Also update Redis for fast access
                    await saveLogoUrl(cId, currentUrl, meta.__iptvOrgMatch ? 'iptv-org' : 'playlist');
                    refreshed++;

                    // Rate limit between refreshes (respect API limits)
                    await new Promise(r => setTimeout(r, 100));

                } catch (err) {
                    errors++;
                    console.error(`[LogoRefresh] Failed for ${sanitizeForLog(cId)}: ${sanitizeForLog(err.message)}`);
                }
            }
        }

        // Task #42 retry-miss pass: a logo whose last fetch FAILED sits in the
        // dead-URL window (isLogoMissPending). The DB still recorded its URL
        // (setLogoUrl is called even on failure), so the changed-URL pass above
        // can't see it — re-attempt those on the same short expiring window
        // until they succeed. Success calls markDeadUrl(url, true) clearing it.
        const { isLogoMissPending, markDeadUrl: markLogoOk } = require('./imageEngine');
        for (const [_configKey, cached] of userCaches.entries()) {
            if (!cached || !cached.channelMap) continue;
            for (const [cId, channel] of cached.channelMap.entries()) {
                const meta = channel.meta;
                if (!meta || !meta.logo) continue;
                const primary = meta.iptvOrgLogo || meta.logo;
                if (!isLogoMissPending(primary)) continue;
                try {
                    const { getPremiumPoster } = require('./imageEngine');
                    const fallbackLogo = meta.iptvOrgLogo ? meta.logo : null;
                    await getPremiumPoster(cId, primary, fallbackLogo, meta.name);
                    markLogoOk(primary);
                    refreshed++;
                    await setLogoUrl(cId, meta.logo, meta.__iptvOrgMatch ? 'iptv-org' : 'playlist');
                    await saveLogoUrl(cId, meta.logo, meta.__iptvOrgMatch ? 'iptv-org' : 'playlist');
                } catch (err) {
                    errors++;
                    console.error(`[LogoRefresh] retry-miss failed for ${sanitizeForLog(cId)}: ${sanitizeForLog(err.message)}`);
                }
            }
        }

        console.log(`[LogoRefresh] Complete: checked=${sanitizeForLog(checked)}, refreshed=${sanitizeForLog(refreshed)}, unchanged=${sanitizeForLog(unchanged)}, errors=${sanitizeForLog(errors)}`);

    } catch (err) {
        console.error('[LogoRefresh] Fatal error:', sanitizeForLog(err.message));
    }
}

/**
 * Prefetches channel logos in rate-limited batches to warm the image cache.
 * @param {Array<{url: string, cId: string, iptvOrgLogo?: string}>} missingLogos - Channel logo details, including playlist and optional iptv-org URLs.
 */
async function queueLogoPrefetch(missingLogos) {
    if (!missingLogos || missingLogos.length === 0) return;

    // Limit concurrent fetches to avoid overwhelming the Worker
    const concurrencyLimit = 10;
    const chunks = [];
    for (let i = 0; i < missingLogos.length; i += concurrencyLimit) {
        chunks.push(missingLogos.slice(i, i + concurrencyLimit));
    }

    for (const chunk of chunks) {
        const promises = chunk.map(async ({ url, cId, iptvOrgLogo }) => {
            try {
                const { getPremiumPoster } = require('./imageEngine');
                const primaryLogo = iptvOrgLogo || url;
                const fallbackLogo = iptvOrgLogo ? url : null;
                await getPremiumPoster(cId, primaryLogo, fallbackLogo, cId);
            } catch (__e) {
                // Ignore pre-fetch errors - they'll be retried on actual request
            }
        });
        await Promise.all(promises);
        // Small delay between chunks to respect rate limits
        await new Promise(r => setTimeout(r, 100));
    }
}

module.exports = { streamFetchIPTV, getEpgText, userCaches, getUserCache, MAX_CACHE_AGE, CACHE_BACKOFF_MIN, CACHE_BACKOFF_MAX, backgroundLogoRefresh, isSafeUrl, revalidateResponseUrl, pickGenres, refreshEpgForEntry, epgScheduleNextRefresh };
