const axios = require('axios');

// tv-logo/tv-logos (https://github.com/tv-logo/tv-logos) is a large,
// hand-curated set of high-resolution channel logos, organized as
// countries/{country-folder}/{channel-slug}-{cc}.png (plus lower-priority
// variant subfolders: hd/, other/, screen-bug/, extra/). It's a much better
// visual source than iptv-org's own (smaller, lower-res) logos.json, so it's
// checked FIRST in the logo priority chain: tv-logos -> iptv-org -> provider
// -> generic fallback (see imageEngine.js for the generic SVG fallback).
//
// The repo only covers ~50 countries/regions (verified against the live
// tree), nowhere near iptv-org's ~250 — for everything outside this list the
// lookup simply misses and the chain falls through to iptv-org/provider as
// before. This is a real coverage gap, not a bug: there is no tv-logos
// content to find for most countries.
const TREE_URL = 'https://api.github.com/repos/tv-logo/tv-logos/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/';
const REFRESH_INTERVAL = 30 * 24 * 60 * 60 * 1000; // monthly — matches the repo's actual commit cadence

// Verified directly against the live repo tree (countries/*/*.{png,svg} top
// level folder names) rather than guessed/slugified from country names, to
// avoid silent mismatches (e.g. "Czechia" vs the repo's "czech-republic").
// Purely regional folders (caribbean, international, nordic, world-*) have
// no single ISO country code and are handled separately below via
// REGION_FOLDER_TO_KEY / COUNTRY_TO_REGIONS instead of being unmapped.
const COUNTRY_FOLDER_TO_CODE = {
    'albania': 'al', 'argentina': 'ar', 'australia': 'au', 'austria': 'at',
    'azerbaijan': 'az', 'belgium': 'be', 'brazil': 'br', 'bulgaria': 'bg',
    'canada': 'ca', 'chile': 'cl', 'costa-rica': 'cr', 'croatia': 'hr',
    'czech-republic': 'cz', 'denmark': 'dk', 'finland': 'fi', 'france': 'fr',
    'germany': 'de', 'greece': 'gr', 'hong-kong': 'hk', 'hungary': 'hu',
    'iceland': 'is', 'india': 'in', 'indonesia': 'id', 'ireland': 'ie',
    'israel': 'il', 'italy': 'it', 'lebanon': 'lb', 'lithuania': 'lt',
    'luxembourg': 'lu', 'malaysia': 'my', 'malta': 'mt', 'mexico': 'mx',
    'netherlands': 'nl', 'new-zealand': 'nz', 'norway': 'no',
    'philippines': 'ph', 'poland': 'pl', 'portugal': 'pt', 'romania': 'ro',
    'russia': 'ru', 'serbia': 'rs', 'singapore': 'sg', 'slovakia': 'sk',
    'slovenia': 'si', 'south-africa': 'za', 'spain': 'es', 'sweden': 'se',
    'switzerland': 'ch', 'turkey': 'tr', 'ukraine': 'ua',
    'united-arab-emirates': 'ae',
    // iptv-org itself uses 'uk' (not the ISO 'gb') as its own country code —
    // matching that convention here, not the raw ISO code, keeps this index
    // usable with the same countryScopeKey values the rest of the app uses.
    'united-kingdom': 'uk', 'united-states': 'us',
};

// The 8 folders that aren't a single country — folder name -> our region key
// -> the filename suffix the repo actually uses for that folder (verified
// against the live tree; not all match the folder name, e.g. "nordic" folder
// uses "-nordic" but "world-europe" uses "-eu", "world-middle-east" uses "-mea").
const REGION_FOLDER_TO_KEY = {
    'nordic': 'nordic', 'international': 'international', 'caribbean': 'caribbean',
    'world-africa': 'africa', 'world-asia': 'asia', 'world-europe': 'europe',
    'world-latin-america': 'latam', 'world-middle-east': 'mea',
};
const REGION_SUFFIX = {
    nordic: 'nordic', international: 'int', caribbean: 'car',
    africa: 'afr', asia: 'asi', europe: 'eu', latam: 'lam', mea: 'mea',
};

// Which regional bucket(s) a given ISO country code should ALSO be checked
// against, as a fallback tier below the country's own dedicated folder (or
// as the primary source for countries with no dedicated folder at all, e.g.
// every Nordic/Caribbean country). A country can reasonably appear in more
// than one bucket (e.g. Egypt in both Middle East and Africa feeds).
// This is intentionally broad-but-plausible rather than exhaustively
// authoritative — it's a fallback tier tried only after a more specific
// lookup misses, so a slightly generous mapping costs nothing but a wasted
// lookup, never a wrong result overriding a real match.
const COUNTRY_TO_REGIONS = {
    // Nordics
    se: ['nordic', 'europe'], no: ['nordic', 'europe'], dk: ['nordic', 'europe'],
    fi: ['nordic', 'europe'], is: ['nordic', 'europe'],
    // Rest of Europe (incl. countries that already have their own folder —
    // harmless extra fallback tier)
    al: ['europe'], am: ['europe'], at: ['europe'], az: ['europe'], ba: ['europe'],
    be: ['europe'], bg: ['europe'], by: ['europe'], ch: ['europe'], cy: ['europe'],
    cz: ['europe'], de: ['europe'], ee: ['europe'], es: ['europe'], fr: ['europe'],
    ge: ['europe'], gr: ['europe'], hr: ['europe'], hu: ['europe'], ie: ['europe'],
    it: ['europe'], li: ['europe'], lt: ['europe'], lu: ['europe'], lv: ['europe'],
    mc: ['europe'], md: ['europe'], me: ['europe'], mk: ['europe'], mt: ['europe'],
    nl: ['europe'], pl: ['europe'], pt: ['europe'], ro: ['europe'], rs: ['europe'],
    ru: ['europe'], si: ['europe'], sk: ['europe'], sm: ['europe'], ua: ['europe'],
    uk: ['europe'], gb: ['europe'], va: ['europe'], xk: ['europe'],
    // Caribbean
    bs: ['caribbean'], bb: ['caribbean'], jm: ['caribbean'], tt: ['caribbean'],
    ht: ['caribbean'], dm: ['caribbean'], gd: ['caribbean'], kn: ['caribbean'],
    lc: ['caribbean'], vc: ['caribbean'], ag: ['caribbean'], ai: ['caribbean'],
    aw: ['caribbean'], bq: ['caribbean'], bm: ['caribbean'], cw: ['caribbean'],
    ky: ['caribbean'], gp: ['caribbean'], mq: ['caribbean'], ms: ['caribbean'],
    sx: ['caribbean'], tc: ['caribbean'], vg: ['caribbean'], vi: ['caribbean'],
    // Latin America (Caribbean nations above are also latam geographically,
    // but tv-logos treats them as a separate folder, so kept separate here)
    ar: ['latam'], br: ['latam'], mx: ['latam'], cl: ['latam'], co: ['latam'],
    pe: ['latam'], ve: ['latam'], ec: ['latam'], uy: ['latam'], py: ['latam'],
    bo: ['latam'], cr: ['latam'], pa: ['latam'], gt: ['latam'], hn: ['latam'],
    sv: ['latam'], ni: ['latam'], do: ['latam'], cu: ['latam'], pr: ['latam'],
    // Middle East
    ae: ['mea'], sa: ['mea'], qa: ['mea'], kw: ['mea'], bh: ['mea'], om: ['mea'],
    jo: ['mea'], lb: ['mea'], sy: ['mea'], iq: ['mea'], ir: ['mea'], il: ['mea'],
    ps: ['mea'], ye: ['mea'], eg: ['mea', 'africa'],
    // Africa
    za: ['africa'], ng: ['africa'], ke: ['africa'], ug: ['africa'], tz: ['africa'],
    et: ['africa'], ao: ['africa'], zm: ['africa'], zw: ['africa'], mw: ['africa'],
    mz: ['africa'], na: ['africa'], bw: ['africa'], ls: ['africa'], sz: ['africa'],
    cd: ['africa'], cg: ['africa'], cm: ['africa'], ga: ['africa'], gq: ['africa'],
    td: ['africa'], cf: ['africa'], sn: ['africa'], sl: ['africa'], lr: ['africa'],
    gn: ['africa'], gw: ['africa'], cv: ['africa'], mr: ['africa'], ml: ['africa'],
    ne: ['africa'], ci: ['africa'], so: ['africa'], dj: ['africa'], er: ['africa'],
    rw: ['africa'], bi: ['africa'], mg: ['africa'], mu: ['africa'], sc: ['africa'],
    km: ['africa'], ma: ['africa'], dz: ['africa'], ly: ['africa'], tn: ['africa'],
    sd: ['africa'], ss: ['africa'],
    // Asia
    cn: ['asia'], jp: ['asia'], kr: ['asia'], kp: ['asia'], tw: ['asia'],
    hk: ['asia'], mo: ['asia'], sg: ['asia'], my: ['asia'], th: ['asia'],
    vn: ['asia'], ph: ['asia'], id: ['asia'], bn: ['asia'], kh: ['asia'],
    la: ['asia'], mm: ['asia'], np: ['asia'], bd: ['asia'], lk: ['asia'],
    mv: ['asia'], bt: ['asia'], pk: ['asia'], af: ['asia'], in: ['asia'],
    kz: ['asia'], uz: ['asia'], kg: ['asia'], tj: ['asia'], tm: ['asia'],
    mn: ['asia'],
};

let countryIndex = new Map(); // code -> Map<normalizedName, url>
let regionIndex = new Map();  // region key -> Map<normalizedName, url>
let lastRefreshed = 0;
let refreshInFlight = null;

/**
 * Creates a normalized channel name for logo matching.
 * @param {string} name - The channel name to normalize.
 * @return {string} The lowercase channel name with non-alphanumeric characters removed.
 */
function normalize(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Strips a trailing "-{suffix}" and file extension from a tv-logos filename
 * to recover the bare channel-name slug.
 * @param {string} filename - e.g. "sky-sports-f1-uk.png"
 * @param {string} suffix - e.g. "uk"
 * @return {string} e.g. "sky-sports-f1"
 */
function stripSuffix(filename, suffix) {
    const noExt = filename.replace(/\.(png|svg)$/i, '');
    const re = new RegExp(`-${suffix}$`, 'i');
    return noExt.replace(re, '');
}

/**
 * Refreshes the channel logo indexes from the tv-logos repository.
 * Failed refreshes leave the existing indexes unchanged.
 */
async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
        try {
            const res = await axios.get(TREE_URL, { timeout: 30000, headers: { 'User-Agent': 'IPTVo/1.0' } });
            const tree = res.data && res.data.tree;
            if (!Array.isArray(tree)) throw new Error('unexpected tree response shape');
            if (res.data.truncated) {
                console.warn('[tv-logos] GitHub tree response was truncated — index may be incomplete');
            }

            const newCountryIndex = new Map();
            const newRegionIndex = new Map();
            // Process top-level files (canonical logos) before variant
            // subfolders (hd/, other/, screen-bug/, extra/) so a canonical
            // logo always wins when both exist for the same channel; variants
            // only fill gaps where no canonical file exists.
            const entries = tree
                .filter(t => t.type === 'blob' && /^countries\/[^/]+\/[^/]+\.(png|svg)$/i.test(t.path));
            const variantEntries = tree
                .filter(t => t.type === 'blob' && /^countries\/[^/]+\/[^/]+\/[^/]+\.(png|svg)$/i.test(t.path));

            for (const e of [...entries, ...variantEntries]) {
                const parts = e.path.split('/');
                const folder = parts[1];
                const filename = parts[parts.length - 1];

                const countryCode = COUNTRY_FOLDER_TO_CODE[folder];
                const regionKey = REGION_FOLDER_TO_KEY[folder];
                if (!countryCode && !regionKey) continue; // unrecognized folder — skip

                const suffix = countryCode || REGION_SUFFIX[regionKey];
                const slug = stripSuffix(filename, suffix);
                const key = normalize(slug);
                if (!key) continue;

                const targetIndex = countryCode ? newCountryIndex : newRegionIndex;
                const targetKey = countryCode || regionKey;
                if (!targetIndex.has(targetKey)) targetIndex.set(targetKey, new Map());
                const bucket = targetIndex.get(targetKey);
                if (!bucket.has(key)) {
                    bucket.set(key, RAW_BASE + e.path);
                }
            }

            countryIndex = newCountryIndex;
            regionIndex = newRegionIndex;
            lastRefreshed = Date.now();
            let total = 0;
            for (const m of countryIndex.values()) total += m.size;
            let regionTotal = 0;
            for (const m of regionIndex.values()) regionTotal += m.size;
            console.log(`[tv-logos] Refreshed: ${countryIndex.size} countries (${total} logos), ${regionIndex.size} regions (${regionTotal} logos)`);
        } catch (e) {
            console.error('[tv-logos] Refresh failed:', e.message);
        } finally {
            refreshInFlight = null;
        }
    })();
    return refreshInFlight;
}

/**
 * Looks up a channel's logo in the tv-logos index. Tries, in order: the
 * channel's own country folder; the regional bucket(s) that country belongs
 * to (nordic, latam, caribbean, mea, africa, asia, europe — see
 * COUNTRY_TO_REGIONS); then "international" as a last resort regardless of
 * country, since pan-regional/international channels can be relayed
 * anywhere.
 * @param {string} name - Cleaned channel name (e.g. "Sky Sports F1").
 * @param {string} countryCode - ISO-ish country code as used elsewhere in
 *   this app (e.g. 'uk', 'rs'); falsy/'global' skips straight to the
 *   country-agnostic "international" tier.
 * @return {string|null} A raw.githubusercontent.com URL, or null.
 */
function lookupTvLogo(name, countryCode) {
    const key = normalize(name);
    if (!key) return null;

    const code = (countryCode && countryCode !== 'global') ? countryCode.toLowerCase() : null;

    if (code) {
        const countryMap = countryIndex.get(code);
        if (countryMap && countryMap.has(key)) return countryMap.get(key);

        for (const region of (COUNTRY_TO_REGIONS[code] || [])) {
            const regionMap = regionIndex.get(region);
            if (regionMap && regionMap.has(key)) return regionMap.get(key);
        }
    }

    const intlMap = regionIndex.get('international');
    if (intlMap && intlMap.has(key)) return intlMap.get(key);

    return null;
}

// Node's setTimeout/setInterval delay is a 32-bit signed int internally —
// anything over ~24.8 days (2147483647 ms) silently overflows and fires
// almost immediately instead of after the intended delay (confirmed: a
// direct setInterval(fn, 30 days) fires within 1ms, then again every 1ms).
// REFRESH_INTERVAL (30 days) exceeds that, so scheduling has to chunk the
// wait into safe-sized steps instead of a single long timer.
const MAX_SAFE_TIMEOUT = 2 ** 31 - 1;

/**
 * Schedules a refresh after the specified delay and continues the recurring refresh cycle.
 * @param {number} delayMs - The delay in milliseconds before the refresh.
 */
function scheduleRefresh(delayMs) {
    const chunk = Math.min(delayMs, MAX_SAFE_TIMEOUT);
    setTimeout(() => {
        const remaining = delayMs - chunk;
        if (remaining > 0) {
            scheduleRefresh(remaining);
        } else {
            refresh().finally(() => scheduleRefresh(REFRESH_INTERVAL));
        }
    }, chunk);
}

/**
 * Refreshes the TV logo indexes immediately and starts the recurring refresh schedule.
 */
function startAutoRefresh() {
    refresh();
    scheduleRefresh(REFRESH_INTERVAL);
}

module.exports = {
    lookupTvLogo,
    startAutoRefresh,
    get lastRefreshed() { return lastRefreshed; },
};
