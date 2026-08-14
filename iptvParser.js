const axios = require('axios');
const readline = require('readline');
const zlib = require('zlib');
const sax = require('sax');
const { Readable } = require('stream');
const { startAiQueue, globalAiCache } = require('./aiCurator');
const { getOverride, getAllOverrides } = require('./db');
const { extractM3uCatchupInfo, extractXtreamCatchupInfo } = require('./catchup');
const { lookupChannel, lookupChannelFuzzy, isValidCountryCode } = require('./iptvOrgRef');

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

// --- Synonym normalization (jr/junior etc) ---
const SYNONYM_MAP = { jr: 'junior' };
function applySynonyms(str) {
    return str.split(/\s+/).map(w => SYNONYM_MAP[w.toLowerCase()] || w).join(' ');
}
const { saveCacheToRedis, saveLogoUrl, loadLogoUrl, hasRedis } = require('./redisCache');
const { getLogoUrl, setLogoUrl } = require('./db');

const userCaches = new Map();
const MAX_CACHE_AGE = 60 * 60 * 1000; // 1 hour

function getUserCache(configKey) {
    const cached = userCaches.get(configKey);
    if (!cached) return null;
    if (Date.now() - cached.lastUpdated > MAX_CACHE_AGE) {
        userCaches.delete(configKey);
        return null;
    }
    return cached;
}

function parseXMLDate(x) {
    if (!x || x.length < 14) return 0;
    try {
        const offset = x.substring(15).trim() || '+0000';
        const fOffset = offset.length === 5 ? `${offset.substring(0,3)}:${offset.substring(3,5)}` : 'Z';
        const isoStr = `${x.substring(0,4)}-${x.substring(4,6)}-${x.substring(6,8)}T${x.substring(8,10)}:${x.substring(10,12)}:${x.substring(12,14)}${fOffset}`;
        const time = new Date(isoStr).getTime();
        if (isNaN(time)) return 0;
        return time;
    } catch (e) {
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
        '<b>':'','</b>':'','🇺':'u','Ⓤ':'u','u':'u','Ｕ':'u','ⓥ':'v','Ⓥ':'v','ｖ':'v','Ｖ':'v','ⓦ':'w','Ⓦ':'w','ｗ':'w','裝':'w','ⓧ':'x','Ⓧ':'x','ｘ':'x','Ｘ':'x','ⓨ':'y','Ⓨ':'y','ｙ':'y','Ｙ':'y',
        'ⓩ':'z','Ⓩ':'z','ｚ':'z','Ｚ':'z'
    };
    return str.split('').map(c => map[c] || c).join('');
}

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

async function streamFetchIPTV(configKey, configObj) {
    if (userCaches.has(configKey)) {
        const existing = userCaches.get(configKey);
        if (existing.status === 'loading') return;
        if (existing.status === 'ready' && (Date.now() - existing.lastUpdated < MAX_CACHE_AGE)) return;
    }
    
    userCaches.set(configKey, { 
        status: 'loading', channelMap: new Map(), logoTracker: new Map(), 
        catalogItems: [], uniqueGroups: new Set(), epgData: {} 
    });
    
    if (configObj && configObj.type === 'xtream') {
        return await parseXtreamData(configKey, configObj);
    } else {
        return await parseM3uData(configKey, configObj);
    }
}

async function parseM3uData(configKey, configObj) {
    const __t0 = Date.now();
    console.log(`[parseM3uData] START for configKey=${configKey ? configKey.substring(0,12) : 'null'}...`);
    const __overridesRows = await getAllOverrides();
    const overridesMap = new Map(__overridesRows.map(o => [o.raw_name, { canonical_id: o.canonical_id, confidence: parseFloat(o.confidence) }]));
    console.log(`[parser] Preloaded ${overridesMap.size} override mappings from DB`);
    try {
        if (!configObj) throw new Error("Configuration context object is missing.");
        const m3uTargetUrl = configObj.m3uUrl || configObj.m3u;
        if (!m3uTargetUrl) throw new Error("No M3U Playlist link found inside payload parameters.");

        // Prevent SSRF: validate URL before fetching
        if (!isSafeUrl(m3uTargetUrl)) {
            throw new Error("Invalid M3U URL: private/internal addresses not allowed");
        }

        const res = await axios({ method: 'get', url: m3uTargetUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 600000 }); // 10 min for large playlists
        let mStream = res.data;
        if (res.headers['content-encoding'] === 'gzip' || m3uTargetUrl.toLowerCase().endsWith('.gz')) mStream = mStream.pipe(zlib.createGunzip());
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

                if (configObj.include && configObj.include.length > 0) {
                    if (!configObj.include.includes(rawGrp)) { cItem = null; continue; }
                } else if (configObj.exclude && configObj.exclude.length > 0) {
                    if (configObj.exclude.includes(rawGrp)) { cItem = null; continue; }
                }

                const tvgId = t.match(/tvg-id=["']([^"']+)["']/i);
                const tvgName = t.match(/tvg-name=["']([^"']+)["']/i);
                const logo = t.match(/tvg-logo=["']([^"']+)["']/i);
                const catchupInfo = extractM3uCatchupInfo(t);
                const rawName = t.lastIndexOf(',') !== -1 ? t.substring(t.lastIndexOf(',') + 1).trim() : "Unknown";
                
                if (/([#\-\*_=\+~]){3,}/.test(rawName) || rawName.includes('----') || rawName.includes('####')) { cItem = null; continue; }
                
                let normGrp = normaliseFormat(rawGrp).toLowerCase();
                let countryPrefix = "";

                // Try to extract country code from group name (e.g., "US | Sports" -> "us")
                const countryMatch = normGrp.match(/^([a-z]{2,3})\b/i);
                if (countryMatch) {
                    const code = countryMatch[1].toUpperCase();
                    if (isValidCountryCode(code)) {
                        countryPrefix = code + " | "; normGrp = normGrp.substring(countryMatch[0].length).trim();
                    }
                }

                // Also check original raw group for country codes that might be in different formats
                if (!countryPrefix) {
                    const rawCountryMatch = rawGrp.match(/^([A-Z]{2,3})\s*[\|\-\:]\s*/);
                    if (rawCountryMatch) {
                        const code = rawCountryMatch[1].toUpperCase();
                        if (isValidCountryCode(code)) {
                            countryPrefix = code + " | ";
                        }
                    }
                }

                let cleanGrp = normGrp.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|h265|live|vod|vip|60fps|50fps|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps)\b/gi, ' ');
                cleanGrp = cleanGrp.replace(/[-\/|:_\s]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                let finalGrp = countryPrefix + cleanGrp;
                if (!cleanGrp || cleanGrp.length < 2) finalGrp = rawGrp;
                const groupTagInfo = parseStreamInfo(rawGrp);
                const groupTags = groupTagInfo.title !== "Direct Stream" ? groupTagInfo.title : null;
                
                let cleanNameStr = normaliseFormat(rawName).toLowerCase();
const timeshiftMatch = cleanNameStr.match(/\+\s*(\d+)\b/);
const timeshiftSuffix = timeshiftMatch ? `_plus${timeshiftMatch[1]}` : '';
let cName = cleanNameStr.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|60fps|50fps|h265|vod|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps|vip|live|backup|alt|online)\b/gi, ' ');
                cName = cName.replace(/\b24\s*[\/_\-]?\s*7\b/gi, ' ');
                cName = cName.replace(/\b\d+[pi]\b|\b\d+\s*fps\b/gi, ' ');
                cName = cName.replace(/^[a-z]{2,3}\b\s*[-:|_\/\|\s]*/gi, ' ');
                cName = cName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
                
                const countryScopeKey = countryPrefix ? countryPrefix.replace(/[^A-Z]/g, '').toLowerCase() : 'global';
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
                    iptvOrgMatch = lookupChannel(baseCleanName, countryScopeKey) || lookupChannelFuzzy(baseCleanName, countryScopeKey);
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
                    const mItem = { id: cId, type: 'tv', name: displayName, genres: [grp], catalogId: catId, logo: displayLogo, fallbackLogo: iptvOrgLogo || logo, rawName: rawName, group: grp, groupTags: groupTags, hasCatchup: !!(catchupInfo && catchupInfo.hasCatchup), catchupDays: catchupInfo ? catchupInfo.catchupDays : 0, __iptvOrgMatch: !!iptvOrgMatch };
                    tMap.set(cId, { meta: mItem, streams: [] });
                    tCat.push(mItem);
                }
                
                const sInfo = parseStreamInfo(rawName);
                tMap.get(cId).streams.push({ name: sInfo.name, title: sInfo.title, url: t, score: sInfo.score, groupTags: groupTags }); 
                cItem = null;
            }
        }
        
        const tEpg = await handleXmltvEpg(configObj.epg, tMap, epgMap);

        // Log iptv-org match statistics
        let iptvOrgMatchCount = 0;
        for (const [, channel] of tMap.entries()) {
            if (channel.meta.__iptvOrgMatch) iptvOrgMatchCount++;
        }
        console.log(`[iptv-org] Matched ${iptvOrgMatchCount}/${tMap.size} channels (${tMap.size > 0 ? Math.round(iptvOrgMatchCount * 100 / tMap.size) : 0}%)`);

        userCaches.set(configKey, { status: 'ready', channelMap: tMap, logoTracker: logoTrack, catalogItems: tCat, uniqueGroups: groups, epgData: tEpg, lastUpdated: Date.now() });
        console.log(`[parser] READY configKey=${configKey ? configKey.substring(0,12) : 'null'}... channels=${tMap.size} groups=${groups.size} elapsed=${Date.now() - __t0}ms`);
        saveCacheToRedis(configKey, userCaches.get(configKey)).catch(e => console.error('[Redis Error] write-through failed:', e.message));

        // Save logo URLs to Redis for change detection (background, non-blocking)
        saveLogoUrlsToRedis(configKey, tMap).catch(e => console.error('[Logo URL Save Error]', e.message));

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
            console.log(`[LogoPrefetch] Queuing ${missingLogos.length} logos for background fetch...`);
            queueLogoPrefetch(missingLogos).catch(e => console.error('[LogoPrefetch] Error:', e.message));
        }

        // Always trigger async background AI process when dirty channels exist
        if (dirtyChannels.length > 0 && configObj.openrouterKey) {
            console.log(`[AI Curator] Starting AI queue with openrouterKey for ${dirtyChannels.length} dirty channels`);
            startAiQueue(dirtyChannels, configKey, configObj.openrouterKey).catch(err => console.error("[AI Queue Error]", err));
        } else if (dirtyChannels.length > 0) {
            console.log(`[AI Curator] Skipping - OpenRouter API key not provided in config. Config keys: ${Object.keys(configObj).join(', ')}, ai=${configObj.ai}`);
        }

    } catch(e) {
        console.error(`[parser] ERROR configKey=${configKey ? configKey.substring(0,12) : 'null'}... message=${e.message} elapsed=${Date.now() - __t0}ms`); userCaches.set(configKey, { status: 'error', message: e.message });
    }
}

async function parseXtreamData(configKey, configObj) {
    const __t0 = Date.now();
    console.log(`[parseXtreamData] START for configKey=${configKey ? configKey.substring(0,12) : 'null'}...`);
    const __overridesRows = await getAllOverrides();
    const overridesMap = new Map(__overridesRows.map(o => [o.raw_name, { canonical_id: o.canonical_id, confidence: parseFloat(o.confidence) }]));
    console.log(`[parser] Preloaded ${overridesMap.size} override mappings from DB`);
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

        console.log(`[Xtream Engine] Querying data channels from endpoint: ${baseUrl}`);

        const [catRes, streamRes] = await Promise.all([
            axios.get(`${apiBase}&action=get_live_categories`, { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } }).catch(() => ({ data: [] })),
            axios.get(`${apiBase}&action=get_live_streams`, { timeout: 90000, headers: { 'User-Agent': 'Mozilla/5.0' } })
        ]);

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

            if (configObj.include && configObj.include.length > 0) {
                if (!configObj.include.includes(rawGrp)) continue;
            } else if (configObj.exclude && configObj.exclude.length > 0) {
                if (configObj.exclude.includes(rawGrp)) continue;
            }

            const rawName = stream.name || "Unknown Channel";
            if (/([#\-\*_=\+~]){3,}/.test(rawName) || rawName.includes('----') || rawName.includes('####')) continue;

            let normGrp = normaliseFormat(rawGrp).toLowerCase();
            let countryPrefix = "";

            // Try to extract country code from group name (e.g., "US | Sports" -> "us")
            const countryMatch = normGrp.match(/^([a-z]{2,3})\b/i);
            if (countryMatch) {
                const code = countryMatch[1].toUpperCase();
                if (isValidCountryCode(code)) {
                    countryPrefix = code + " | "; normGrp = normGrp.substring(countryMatch[0].length).trim();
                }
            }

            // Also check original raw group for country codes that might be in different formats
            if (!countryPrefix) {
                const rawCountryMatch = rawGrp.match(/^([A-Z]{2,3})\s*[\|\-\:]\s*/);
                if (rawCountryMatch) {
                    const code = rawCountryMatch[1].toUpperCase();
                    if (isValidCountryCode(code)) {
                        countryPrefix = code + " | ";
                    }
                }
            }

            let cleanGrp = normGrp.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|h265|live|vod|vip|60fps|50fps|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps)\b/gi, ' ');
            cleanGrp = cleanGrp.replace(/[-\/|:_\s]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
            let finalGrp = countryPrefix + cleanGrp;
            if (!cleanGrp || cleanGrp.length < 2) finalGrp = rawGrp;
            const groupTagInfo = parseStreamInfo(rawGrp);
            const groupTags = groupTagInfo.title !== "Direct Stream" ? groupTagInfo.title : null;

            let cleanNameStr = normaliseFormat(rawName).toLowerCase();
const timeshiftMatch = cleanNameStr.match(/\+\s*(\d+)\b/);
const timeshiftSuffix = timeshiftMatch ? `_plus${timeshiftMatch[1]}` : '';
let cName = cleanNameStr.replace(/\b(hd|fhd|uhd|4k|8k|sd|raw|hevc|1080p|1080i|720p|60fps|50fps|h265|vod|dolby|audio|vision|atmos|dv|dovi|ac3|eac3|fps|vip|live|backup|alt|online)\b/gi, ' ');
            cName = cName.replace(/\b24\s*[\/_\-]?\s*7\b/gi, ' ');
            cName = cName.replace(/\b\d+[pi]\b|\b\d+\s*fps\b/gi, ' ');
            cName = cName.replace(/^[a-z]{2,3}\b\s*[-:|_\/\|\s]*/gi, ' ');
            cName = cName.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

            const countryScopeKey = countryPrefix ? countryPrefix.replace(/[^A-Z]/g, '').toLowerCase() : 'global';
            const baseCleanName = applySynonyms(cName).replace(/[^a-z0-9]/g, "") || "unknown";
            
            // No 'iptv:' prefix - colons in IDs can break client URL parsing
            let cId = `${countryScopeKey}_${baseCleanName}${timeshiftSuffix}`;

            // 1. Check iptv-org reference data first (authoritative source) using cleaned name
            // Only run iptv-org matching if explicitly enabled in config
            let iptvOrgMatch = null;
            if (configObj.iptvOrg) {
                iptvOrgMatch = lookupChannel(baseCleanName, countryScopeKey) || lookupChannelFuzzy(baseCleanName, countryScopeKey);
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

            let finalLogo = stream.stream_icon || '';

            logoTrack.set(cId, { url: finalLogo, name: cName });
            // Store iptv-org logo separately for fallback chain
            const iptvOrgLogo = iptvOrgMatch ? iptvOrgMatch.logo : null;

            const catId = `iptv_${finalGrp.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
            groups.add(finalGrp);

            if (!tMap.has(cId)) {
                const displayName = iptvOrgMatch ? iptvOrgMatch.canonicalName : cName.replace(/\b\w/g, c => c.toUpperCase());
                const displayLogo = iptvOrgMatch ? iptvOrgMatch.logo : finalLogo;
                const mItem = { id: cId, type: 'tv', name: displayName, genres: [finalGrp], catalogId: catId, logo: displayLogo, fallbackLogo: iptvOrgLogo || finalLogo, rawName: rawName, group: finalGrp, groupTags: groupTags, hasCatchup: !!(catchupInfo && catchupInfo.hasCatchup), catchupDays: catchupInfo ? catchupInfo.catchupDays : 0, __iptvOrgMatch: !!iptvOrgMatch };
                tMap.set(cId, { meta: mItem, streams: [] });
                tCat.push(mItem);
            }

            const sInfo = parseStreamInfo(rawName);
            const liveStreamUrl = `${baseUrl}/live/${user}/${pass}/${stream.stream_id}.ts`;
            
            tMap.get(cId).streams.push({ name: sInfo.name, title: sInfo.title, url: liveStreamUrl, score: sInfo.score, groupTags: groupTags });
        }

        const tEpg = await handleXmltvEpg(epg, tMap, epgMap);

        // Log iptv-org match statistics
        let iptvOrgMatchCount = 0;
        for (const [, channel] of tMap.entries()) {
            if (channel.meta.__iptvOrgMatch) iptvOrgMatchCount++;
        }
        console.log(`[iptv-org] Matched ${iptvOrgMatchCount}/${tMap.size} channels (${tMap.size > 0 ? Math.round(iptvOrgMatchCount * 100 / tMap.size) : 0}%)`);

        userCaches.set(configKey, { status: 'ready', channelMap: tMap, logoTracker: logoTrack, catalogItems: tCat, uniqueGroups: groups, epgData: tEpg, lastUpdated: Date.now() });
        console.log(`[parser] READY configKey=${configKey ? configKey.substring(0,12) : 'null'}... channels=${tMap.size} groups=${groups.size} elapsed=${Date.now() - __t0}ms`);
        saveCacheToRedis(configKey, userCaches.get(configKey)).catch(e => console.error('[Redis Error] write-through failed:', e.message));
        console.log(`[Xtream Engine] Categorized and loaded ${tCat.length} streams inside memory.`);

        // Save logo URLs to Redis for change detection (background, non-blocking)
        saveLogoUrlsToRedis(configKey, tMap).catch(e => console.error('[Logo URL Save Error]', e.message));

        if (dirtyChannels.length > 0 && configObj.openrouterKey) {
            startAiQueue(dirtyChannels, configKey, configObj.openrouterKey).catch(err => console.error("[AI Queue Error]", err));
        } else if (dirtyChannels.length > 0) {
            console.log(`[AI Curator] Skipping - OpenRouter API key not provided in config`);
        }

    } catch(e) {
        console.error("[Xtream Engine Error]", e.message);
        console.error(`[parser] ERROR configKey=${configKey ? configKey.substring(0,12) : 'null'}... message=${e.message} elapsed=${Date.now() - __t0}ms`); userCaches.set(configKey, { status: 'error', message: e.message });
    }
}

async function handleXmltvEpg(epgUrl, tMap, epgMap) {
    const tEpg = {};
    if (!epgUrl) return tEpg;

    // Prevent SSRF: validate EPG URL before fetching
    if (!isSafeUrl(epgUrl)) {
        console.error('[handleXmltvEpg] Invalid EPG URL: private/internal addresses not allowed');
        return tEpg;
    }

    return new Promise(async (resolve) => {
        try {
            const epgRes = await axios({ method: 'get', url: epgUrl, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0' }, timeout: 300000 });
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
            let currentTag = null;
            let currentText = '';

            saxStream.on('opentag', (node) => {
                if (node.name === 'programme') {
                    currentProgramme = {
                        start: parseXMLDate(node.attributes.start || ""),
                        stop: parseXMLDate(node.attributes.stop || ""),
                        channel: node.attributes.channel ? node.attributes.channel.toLowerCase().trim() : ""
                    };
                }
                currentTag = node.name;
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

            saxStream.on('end', () => {
                resolve(tEpg);
            });

            saxStream.on('error', (err) => {
                console.error('[EPG SAX Error]', err.message);
                resolve(tEpg);
            });

            finalizedStream.pipe(saxStream);
        } catch(e) { 
            console.error("EPG Error", e.message); 
            resolve(tEpg);
        }
    });
}

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

module.exports = { streamFetchIPTV, getEpgText, userCaches, getUserCache, MAX_CACHE_AGE, backgroundLogoRefresh };

/**
 * Save logo URLs to both Redis (fast access) and Database (persistent, no expiry).
 * Runs in background after parsing completes.
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
        console.log(`[LogoCache] Saved ${saved} logo URLs for change tracking (Redis + DB)`);
    }
}

/**
 * Background logo refresh - only refresh logos that have changed URLs
 * or are new (haven't been fetched before).
 * Uses Database for persistent URL tracking (survives restarts, no expiry).
 * Runs periodically to respect rate limits.
 */
async function backgroundLogoRefresh() {
    console.log('[LogoRefresh] Starting background logo refresh...');
    let checked = 0;
    let refreshed = 0;
    let unchanged = 0;
    let errors = 0;

    try {
        for (const [configKey, cached] of userCaches.entries()) {
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
                console.log(`[LogoRefresh] Logo URL changed/new for ${cId}, refreshing...`);

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
                    console.error(`[LogoRefresh] Failed for ${cId}: ${err.message}`);
                }
            }
        }

        console.log(`[LogoRefresh] Complete: checked=${checked}, refreshed=${refreshed}, unchanged=${unchanged}, errors=${errors}`);

    } catch (err) {
        console.error('[LogoRefresh] Fatal error:', err.message);
    }
}

/**
 * Background logo pre-fetch queue - fetches logos for channels without iptv-org match
 * to warm up the Cloudflare Worker cache (which caches at edge for 30 days).
 * Fire-and-forget, runs during parsing.
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
            } catch (e) {
                // Ignore pre-fetch errors - they'll be retried on actual request
            }
        });
        await Promise.all(promises);
        // Small delay between chunks to respect rate limits
        await new Promise(r => setTimeout(r, 100));
    }
}

module.exports = { streamFetchIPTV, getEpgText, userCaches, getUserCache, MAX_CACHE_AGE, backgroundLogoRefresh };
