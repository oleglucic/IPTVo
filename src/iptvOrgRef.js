const axios = require('axios');
const Fuse = require('fuse.js');
const log = require('./logger').for('iptvOrgRef');

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

// Single combined exact-match Map: key = "${normalizedName}|${countryCode}"
// countryCode = '' for global (no country) entries
let exactMatchMap = new Map();
let channelIdToLogo = new Map();
let validCountryCodes = new Set();
// Full set of real iptv-org official channel ids (lowercased), independent
// of logo coverage — channelIdToLogo only has entries for channels that
// happen to have a logo in iptv-org's separate logos.json feed, so it can't
// be used to check "does this officialId exist at all" (false negatives for
// real, logo-less channels). Used to validate an officialId a client claims
// is a real iptv-org entry before trusting it with high confidence — see
// isValidOfficialId below and its use in server.js's community-match route.
let validOfficialIds = new Set();
let fuseIndex = null;
let fuseList = null;
let lastRefreshed = 0;

// --- Token-aware + alias-aware match tier --------------------------------------
// Provider playlists rarely use iptv-org's exact names, so a flattened exact
// map misses most real input ("CNN Intl", "DW English", "The Blaze"). These
// structures add token-set equality, alias expansion, and a prefix/abbreviation
// fallback — the tiers that rescue the common playlist naming quirks.
const TOKEN_SPLIT = /[^a-z0-9]+/;
const SUFFIX_WORDS = new Set([
    'hd','fhd','uhd','4k','8k','sd','raw','hevc','1080p','1080i','720p','h265',
    'vod','dolby','audio','vision','atmos','dv','dovi','ac3','eac3','vip','live',
    'backup','alt','online','english','french','german','spanish','intl','international',
    'uk','us','usa','america','east','west','timeshift','plus','premium','quality'
    // Note: 'm' (the Movistar+ brand) is intentionally NOT a stop-word here —
    // a leading "m laliga"/"m deportes" is the M+ operator, and the matcher
    // must keep the single-letter brand token so it aligns to "por Movistar".
]);
// Brand aliases so alternate or abbreviated spellings converge on one channel.
const ALIASES = {
    'deutsche welle': 'dw',
    'russia today': 'rt',
    'the blaze': 'blaze',
    'history channel': 'history',
    'national geographic': 'nat geo',
    'fox news channel': 'fox news',
    'cnbc world': 'cnbc',
    'bbc world news': 'bbc world',
    // language qualifier spells the channel's global variant
    'france 24 english': 'france 24',
    // Spanish operator "M+" (Movistar): playlists write "m laliga" / "m deportes",
    // iptv-org spells "LaLiga por Movistar+" / "Deportes por Movistar+".
    // Spanish operator "M+" (Movistar): playlists write "m laliga" / "m deportes",
    // iptv-org spells "LaLiga por Movistar+" / "Deportes por Movistar+".
    'm': 'movistar',
    'm+': 'movistar',
    // Disney's 2022-2024 wind-down of the international "Fox" brand in favor
    // of "Star" (Balkans/Bulgaria/Portugal/Middle East/India/Latin America)
    // — verified against iptv-org's own data: some countries' entries were
    // updated to the new name (e.g. StarLife.bg replaced FoxLife.bg) while
    // others (e.g. FoxLife.rs) are still sitting on the pre-rebrand name
    // despite the same October 2023 Balkans rebrand having applied there
    // too — a real, ongoing gap in iptv-org's crowdsourced data, not
    // something a single country's entry can fix on its own. Aliasing both
    // forms to the same token set means a provider's channel is found
    // correctly regardless of which side (the provider or iptv-org) is
    // using the current name for that particular country. Kept to safe,
    // distinctive 2-word phrases — no bare "fox"/"star" alias, since either
    // word alone collides with completely unrelated real channels ("Fox
    // News", "Star Sports", "Star World", ...).
    'fox life': 'star life',
    'fox crime': 'star crime',
    'fox movies': 'star movies',
    // Viasat's own movie-channel family rebrand (TV1000 -> Viasat Kino and
    // its Action/Comedy/Megahit/World variants) — verified against iptv-org
    // (e.g. ViasatKino.ua lists "TV1000 East" as an alt_name already, but
    // other countries' TV1000 entries have no Viasat Kino alt_name at all).
    'tv1000': 'viasat kino',
};
// Reverse direction too: iptv-org's official short name -> playlist long name.
// The reverse is skipped when the abbreviation is a bare single letter, and
// when a canonical name already got a reverse — 'm' and 'm+' both alias to
// 'movistar', and a reverse entry would collapse the iptv-org brand token
// "movistar" down to a single-letter "m" during tokenize (wrong-match risk).
// The forward m/m+ -> movistar expansion is what playlists rely on.
const ALIAS_BILATERAL = new Map();
for (const [k, v] of Object.entries(ALIASES)) {
    ALIAS_BILATERAL.set(k, v);
    if (k.length > 1 && !ALIAS_BILATERAL.has(v)) ALIAS_BILATERAL.set(v, k);
}
// Precompile alias regexes once: each tokenize() call otherwise rebuilds them.
const ALIAS_PATTERNS = Array.from(ALIAS_BILATERAL.entries())
    .map(([k, v]) => {
        const separatorInsensitiveKey = k.split(/[^a-z0-9]+/).filter(Boolean).join('[^a-z0-9]*');
        return [new RegExp(`\\b${separatorInsensitiveKey}\\b`, 'i'), v];
    });

let tokenIndex = new Map();        // sortedKey -> entry[] (one per distinct country sharing that token set)
let tokenByFirst = new Map();      // firstToken -> [entry] (bucketed subsequence search)
let fuseByFirst = new Map();       // leading token -> Fuse over entries sharing it

// Cap for the tier-3 subsequence bucket scan. Single-letter first tokens
// ("m", "tv") gather thousands of iptv-org entries; without a bound a single
// misnamed channel could scan the whole bucket and stall the entire parse.
const MAX_T3_SCAN = 2000;

// Simple LRU cache for normalize() - max 5000 entries
const normalizeCache = new Map();
const NORMALIZE_CACHE_MAX = 5000;

/**
 * Normalizes a string by lowercasing it and removing non-alphanumeric characters.
 * @param {string} str - The string to normalize.
 * @return {string} The normalized string, or an empty string for falsy input.
 */
function normalize(str) {
    if (!str) return '';
    const cached = normalizeCache.get(str);
    if (cached !== undefined) return cached;
    const result = str.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizeCache.size >= NORMALIZE_CACHE_MAX) {
        // Remove oldest entry (first key)
        const firstKey = normalizeCache.keys().next().value;
        normalizeCache.delete(firstKey);
    }
    normalizeCache.set(str, result);
    return result;
}

/**
 * Converts a channel name into normalized tokens and removes recognized noise terms.
 * @param {string} name - The channel name to tokenize.
 * @param {boolean} [applyAliases=true] - Whether to expand recognized brand aliases.
 * @return {string[]} The normalized channel tokens.
 */
// Small, deliberately conservative word-form equivalence table applied
// per-token in tokenize() — NOT a general English stemmer (which would risk
// false collisions like "news" -> "new"). Only well-known singular/plural
// pairs that commonly vary between providers and iptv-org's own naming
// (iptv-org itself is inconsistent: compare "PremierSport1.sk" singular vs
// "PremierSports1.ie" plural for the same brand) go here.
const WORD_EQUIVALENTS = {
    'sport': 'sports',
    'movie': 'movies',
    'kid': 'kids',
};

function tokenize(name, applyAliases = true) {
    if (!name) return [];
    let s = String(name).toLowerCase();
    if (applyAliases) {
        const flat = s.replace(/[^a-z0-9]+/g, ' ');
        // Longest alias first so multi-word aliases win over shorter fragments.
        const long = ALIAS_BILATERAL.get(flat.trim());
        if (long) s = long;
        else {
            for (const [pat, v] of ALIAS_PATTERNS) {
                // whole-word span at token boundaries (precompiled)
                if (pat.test(s)) { s = s.replace(pat, v); break; }
            }
        }
        // Expand a bare single-letter brand token: "m" -> "movistar". The
        // ALIASES loop above only fires for phrases; this handles a lone "m".
        if (!long && /^\s*[a-z0-9]\s*$/.test(s)) {
            const single = ALIAS_BILATERAL.get(s.trim());
            if (single) s = single;
        }
    }
    const toks = s.split(TOKEN_SPLIT).filter(Boolean);
    // Drop noise tokens (HD/UK/Plus/…), then normalize known singular/plural
    // word-form pairs so e.g. "sport" and "sports" always tokenize the same
    // regardless of which form the provider or iptv-org itself used.
    return toks.filter(t => !SUFFIX_WORDS.has(t) && t.length > 0)
        .map(t => WORD_EQUIVALENTS[t] || t);
}

/**
 * Creates order-sensitive and order-insensitive keys from a token list.
 * @param {string[]} tokens - The tokens used to build the keys.
 * @returns {{sortedKey: string, orderedKey: string}} An object containing the alphabetically sorted token key and the original-order token key.
 */
function tokensToKeys(tokens) {
    const sorted = [...tokens].sort((a, b) => a.localeCompare(b)).join(' ');
    const ordered = tokens.join(' ');
    return { sortedKey: sorted, orderedKey: ordered };
}

/**
 * Appends an entry to a sortedKey's bucket in the token index, keeping at
 * most one entry per distinct country (the first one seen for that
 * country). Replaces the old "first entry ever wins, globally, across every
 * country" scheme — that scheme meant a name shared by two countries (e.g.
 * "Hype TV" in both Jamaica and Serbia) only ever kept ONE of them in the
 * index, silently dropping the other regardless of what country a lookup
 * asked for.
 * @param {Map<string, Array>} map
 * @param {string} key
 * @param {Object} entry
 */
function addToTokenIndex(map, key, entry) {
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    if (!arr.some(e => e.country === entry.country)) arr.push(entry);
}

/**
 * Greedy subsequence match: does `query` occur as a token-subsequence of `cand`?
 * e.g. query ["cnn","intl"] vs cand ["cnn","international"] → true (int prefix).
 * query ["bbc","world"] vs ["bbc","world","news"] → true (prefix).
 * Uses per-token prefix for abbreviation tolerance.
 */
// Region markers that make a channel a regional/pan-regional feed, NOT the
// specific country the user scoped to. If the user asked for scope 'us' and a
// candidate is "HBO Latin America", accepting it is a wrong-region false
// positive — a stale-but-correct MISS is better than a wrong channel.
const REGION_MARKERS = ['latin america', 'latinamerican', 'caribbean', 'amtv', 'brazil', 'mexico', 'latinamerica', 'nordic', 'emea', 'asia', 'europe', 'pacific'];
/**
 * Determines whether a channel name indicates a regional feed that conflicts with a specific country scope.
 * @param {string} name - The channel name to evaluate.
 * @param {string} countryScopeKey - The requested country scope.
 * @return {boolean} `true` if the name contains a regional marker while a specific country scope is active, `false` otherwise.
 */
function isRegionConflicting(name, countryScopeKey) {
    if (!countryScopeKey || countryScopeKey === 'global') return false;
    const n = (name || '').toLowerCase();
    // When a marker IS the requested country scope ("Brazil" feed under a
    // "br" scope), it is not a conflict — the country's own primary feed.
    // Only a marker naming a DIFFERENT region/pan-region is a false positive.
    if (REGION_MARKERS.includes(countryScopeKey)) return false;
    return REGION_MARKERS.some(m => n.includes(m));
}

/**
 * Determines whether query tokens match candidate tokens in order.
 * @param {string[]} query - The tokens to find.
 * @param {string[]} cand - The candidate tokens to inspect.
 * @return {boolean} `true` if each query token matches an equal or prefixed candidate token in order, `false` otherwise.
 */
function isSubsequence(query, cand) {
    let c = 0;
    for (const q of query) {
        let found = false;
        while (c < cand.length) {
            if (cand[c] === q || cand[c].startsWith(q)) { found = true; c++; break; }
            c++;
        }
        if (!found) return false;
    }
    return true;
}

/**
 * Order-insensitive token containment: every query token appears in cand
 * (prefix-tolerant). Used for branded queries (e.g. "m vamos" = [movistar,
 * vamos]) where the iptv-org entry may list the brand token at ANY position —
 * "Vamos por Movistar+" is [vamos, movistar, plus]. Ordered subsequence would
 * wrongly require movistar to precede vamos.
 */
function isTokenSubset(query, cand) {
    for (const q of query) {
        const hit = cand.some(c => c === q || c.startsWith(q));
        if (!hit) return false;
    }
    return true;
}

/**
 * Refreshes channel, logo, and country indexes from iptv-org data.
 *
 * Failed refreshes preserve the existing indexes.
 */
async function refresh() {
    try {
        const [channelsRes, logosRes, countriesRes] = await Promise.all([
            axios.get(CHANNELS_URL, { timeout: 15000 }),
            axios.get(LOGOS_URL, { timeout: 15000 }),
            axios.get(COUNTRIES_URL, { timeout: 15000 })
        ]);

        const newExactMap = new Map();
        const newFuseList = [];
        const newTokenIndex = new Map();   // sortedKey -> entry[]
        // Tracks, per normalized name, which distinct countries have a channel
        // with that name. Used below to refuse to populate the unscoped
        // "name|" global fallback slot for names that collide across more
        // than one country (e.g. "RTS 1" exists in RS, CH, and SN) — populating
        // it would make an unscoped lookup silently pick whichever country's
        // channel happened to load first, which is wrong far more often than
        // it's right for popular acronym-style names.
        const nameCountryCounts = new Map(); // normalizedName -> Set<country>
        const newValidOfficialIds = new Set();

        for (const ch of channelsRes.data) {
            newValidOfficialIds.add(String(ch.id).toLowerCase());
            if (ch.closed) continue;
            const names = [ch.name, ...(ch.alt_names || [])];
            const countryLower = (ch.country || '').toLowerCase();
            const officialId = ch.id; // format: "ChannelName.countrycode"
            const entry = { officialId, name: ch.name, country: countryLower, logo: null, categories: ch.categories || [] };

            // Token-aware index entries. We index each distinct token set for
            // robust order-insensitive matching ("News Fox" vs "Fox News").
            const tokenKeys = new Set();
            for (const nm of names) {
                const toks = tokenize(nm, false); // no alias here; alias handled at query time
                if (toks.length === 0) continue;
                const { sortedKey } = tokensToKeys(toks);
                tokenKeys.add(sortedKey);
            }
            for (const sk of tokenKeys) {
                addToTokenIndex(newTokenIndex, sk, entry);
            }

            for (const n of names) {
                const key = normalize(n);
                if (!key) continue;

                // Composite key: "normalizedName|countryCode"
                const compositeKey = `${key}|${countryLower}`;
                if (!newExactMap.has(compositeKey)) {
                    newExactMap.set(compositeKey, entry);
                }

                if (countryLower) {
                    if (!nameCountryCounts.has(key)) nameCountryCounts.set(key, new Set());
                    nameCountryCounts.get(key).add(countryLower);
                }

                // Also add global (no-country) fallback for the first name only
                if (n === ch.name) {
                    const globalKey = `${key}|`;
                    if (!newExactMap.has(globalKey)) {
                        newExactMap.set(globalKey, { ...entry, country: '' });
                    }
                }
            }

            // Build Fuse list entry (use primary name only to keep index smaller)
            const primaryKey = normalize(ch.name);
            if (primaryKey && primaryKey.length >= 3) {
                newFuseList.push({ key: primaryKey, officialId, name: ch.name, country: countryLower });
            }
        }

        // Second pass: strip the global fallback for any name that turned out
        // to be ambiguous (present in 2+ distinct countries). An unscoped
        // query for one of these now correctly falls through to the
        // token/subsequence/fuzzy tiers (which DO respect countryScopeKey and
        // isRegionConflicting) instead of returning a confidently wrong country.
        for (const [key, countries] of nameCountryCounts) {
            if (countries.size > 1) {
                newExactMap.delete(`${key}|`);
            }
        }

        // Logos
        const newLogoMap = new Map();
        for (const logo of logosRes.data) {
            if (logo.channel && !newLogoMap.has(logo.channel)) {
                newLogoMap.set(logo.channel, logo.url);
            }
        }

        // Countries
        const newCountrySet = new Set(countriesRes.data.map(c => c.code.toLowerCase()));

        // Build name->code reverse map from iptv-org's own country data
        // (e.g. {name:'Greece', code:'GR'}) so region groups like "EURO | GREECE"
        // can be scoped to the inner country. Names are normalized by removing
        // non-letters so "Czech & Slovak", "Bosnia-Herzegovina" still match.
        const newCountryNameToCode = new Map();
        for (const c of countriesRes.data) {
            const nm = (c.name || '').toLowerCase().replace(/[^a-z]/g, '');
            if (nm && c.code) newCountryNameToCode.set(nm, c.code.toLowerCase());
        }

        // Build Fuse indexes: one global + one per leading token. The global
        // index is the fallback; the per-token indexes let the fuzzy tier in
        // lookupChannelSmart[Fuzzy] only scan the handful of entries sharing the
        // query's first token instead of the full ~39k list on every miss —
        // the full-index scan dominated parse time on large playlists.
        const fuseOpts = {
            keys: ['key'],
            threshold: 0.25,
            includeScore: true,
            minMatchCharLength: 3,
            ignoreLocation: true,
            distance: 1000
        };
        const newFuseIndex = new Fuse(newFuseList, fuseOpts);
        const newFuseByFirst = new Map();
        for (const e of newFuseList) {
            // Bucket by the *tokenized* first token (word boundary preserved),
            // not by the normalized key — normalise() strips spaces, so
            // key.split(' ')[0] would collapse every multi-word channel into
            // its own giant bucket and defeat bucketing entirely.
            const toks = tokenize(e.name, false);
            const firstTok = toks[0] || '';
            if (!firstTok) continue;
            let arr = newFuseByFirst.get(firstTok);
            if (!arr) { arr = []; newFuseByFirst.set(firstTok, arr); }
            arr.push(e);
        }
        for (const [k, arr] of newFuseByFirst) newFuseByFirst.set(k, new Fuse(arr, fuseOpts));

        // Also index the alias-expanded forms so a swap works both directions
        // ("DW English" -> Deutsche Welle, "Deutsche Welle" -> DW). Only the
        // first name needs aliasing; alt_names get their own direct index above.
        for (const ch of channelsRes.data) {
            if (ch.closed) continue;
            const countryLower = (ch.country || '').toLowerCase();
            const entry = { officialId: ch.id, name: ch.name, country: countryLower, logo: null, categories: ch.categories || [] };
            const toks = tokenize(ch.name, true); // alias-aware
            if (!toks.length) continue;
            const { sortedKey } = tokensToKeys(toks);
            addToTokenIndex(newTokenIndex, sortedKey, entry);
        }

        exactMatchMap = newExactMap;
        channelIdToLogo = newLogoMap;
        validCountryCodes = newCountrySet;
        validOfficialIds = newValidOfficialIds;
        countryNameToCode = newCountryNameToCode;
        fuseIndex = newFuseIndex;
        fuseList = newFuseList;
        fuseByFirst = newFuseByFirst;
        tokenIndex = newTokenIndex;

        // Bucket token entries by their leading token — from the source name,
        // not the alphabetical sortedKey — so the subsequence tier in
        // lookupChannelSmart scans the handful that share the query's leading
        // token, instead of the full 48k-index on every miss.
        const newTokenByFirst = new Map();
        for (const [, arr] of newTokenIndex.entries()) {
            for (const entry of arr) {
                const leadToks = tokenize(entry.name, false);
                const firstTok = leadToks[0] || '';
                if (!firstTok) continue;
                const bucket = newTokenByFirst.get(firstTok);
                if (bucket) bucket.push(entry);
                else newTokenByFirst.set(firstTok, [entry]);
            }
        }
        tokenByFirst = newTokenByFirst;
        // The set of leading tokens present in the index — used to gate the
        // fuse-fuzzy tier so a name whose leading token never appears in any
        // indexed entry skips the ~39k-entry scan entirely.
        leadingTokens = new Set(newTokenByFirst.keys());
        lastRefreshed = Date.now();

        log.info(`Refreshed: ${exactMatchMap.size} exact entries, ${channelIdToLogo.size} logos, ${validCountryCodes.size} countries, ${fuseList.length} fuse entries, ${tokenIndex.size} token entries.`);
    } catch (e) {
        log.error('Refresh failed, keeping previous data:', e.message);
    }
}

/**
 * Exact lookup by cleaned name and optional country scope.
 * @param {string} cleanName - Already normalized channel name (lowercase, alphanumeric only)
 * @param {string} [countryScopeKey] - Optional country code like 'us', 'gb' (lowercase) or 'global'
 * @returns {Object|null} Match object with countryScopeKey, canonicalName, logo, officialId
 */
function lookupChannel(cleanName, countryScopeKey) {
    if (!cleanName) return null;

    // Try country-specific first
    if (countryScopeKey && countryScopeKey !== 'global') {
        const match = exactMatchMap.get(`${cleanName}|${countryScopeKey}`);
        if (match) {
            return buildMatchResult(match);
        }
        // A real, validated scope was provided and its scoped lookup missed —
        // do NOT fall through to the unscoped/global slot below. That slot is
        // "first channel with this name wins" across ALL countries (see
        // refresh()), so for a name that exists in multiple countries (e.g.
        // "RTS 1" exists as RTS1.rs in Serbia AND RTS1.ch in Switzerland) it
        // silently returns whichever one happened to load first — which is
        // very often the WRONG country. Once we know the real country, a miss
        // there means "no match", never "guess a different country".
        return null;
    }

    // No scope known — the global slot is the only option, and refresh()
    // already refuses to populate it for names that are ambiguous across
    // more than one country, so this never returns a coin-flip wrong match.
    const globalMatch = exactMatchMap.get(`${cleanName}|`);
    if (globalMatch) {
        return buildMatchResult(globalMatch);
    }

    return null;
}

/**
 * Builds a standardized channel match result from channel metadata.
 * @param {Object} match - Channel metadata containing the name, country, official ID, and categories.
 * @returns {Object} A match result with country scope, canonical name, logo, official ID, and categories.
 */
function buildMatchResult(match) {
    return {
        countryScopeKey: match.country || 'global',
        canonicalName: match.name,
        logo: channelIdToLogo.get(match.officialId) || null,
        officialId: match.officialId,
        categories: match.categories || []
    };
}

/**
 * Finds a conservatively matched channel name using fuzzy search and optional country filtering.
 * @param {string} cleanName - Normalized channel name to search for.
 * @param {string} [countryScopeKey] - Country code used to filter matches.
 * @param {string} [firstTokHint] - Leading token used to narrow the search index.
 * @returns {Object|null} A fuzzy match with channel metadata and score, or `null` when no suitable match is found.
 */
function lookupChannelFuzzy(cleanName, countryScopeKey, firstTokHint) {
    if (!fuseIndex || !cleanName || cleanName.length < 4) return null;

    // Search only the per-first-token index — a tiny fraction of the full
    // corpus — and fall back to the global index only when the hinted bucket
    // is unknown. The caller (lookupChannelSmart) already tokenized the name
    // and knows the true leading token; passing it as a hint keeps the 39k-entry
    // full-index scan from ever running on the common miss path.
    let idx = null;
    const firstTok = firstTokHint || ((cleanName.split(' ')[0]) || '');
    if (firstTok) {
        idx = fuseByFirst.get(firstTok) || null;
    }
    const results = idx ? idx.search(cleanName, { limit: 8 }) :
        fuseIndex.search(cleanName, { limit: 8 });
    if (!results.length) return null;

    for (const result of results) {
        if (result.score > 0.2) continue; // enforce conservative threshold
        const match = result.item;

        // Country filtering. countryScopeKey can be the literal string
        // 'global' (no country known) — that's a sentinel, not a real ISO
        // code, so it must be excluded here exactly like Tiers 2 and 3 do
        // (`!countryScopeKey || countryScopeKey === 'global'`). Without this,
        // `match.country !== 'global'` is true for every real candidate
        // (country codes are never literally "global"), so EVERY fuzzy
        // candidate was rejected on every unscoped lookup — the entire fuzzy
        // tier was silently dead whenever no country was resolved, which is
        // the majority of real-world lookups (any group/channel name that
        // doesn't cleanly resolve to one country).
        if (countryScopeKey && countryScopeKey !== 'global' && match.country !== countryScopeKey) continue;
        // Reject regional/pan-regional feeds that share the scope code (e.g.
        // "HBO Latin America" is country 'us' but is not the US feed).
        if (isRegionConflicting(match.name, countryScopeKey)) continue;

        return {
            countryScopeKey: match.country || 'global',
            canonicalName: match.name,
            logo: channelIdToLogo.get(match.officialId) || null,
            officialId: match.officialId,
            categories: match.categories || [],
            fuzzy: true,
            fuzzyScore: result.score
        };
    }
    return null;
}

/**
 * Matches a channel name using exact, token-based, alias-aware, and fuzzy matching.
 * @param {string} cleanName - Channel name to match.
 * @param {string} [countryScopeKey] - Country code used to restrict matching, or `global`.
 * @returns {Object|null} A standardized channel match with canonical name, official ID, logo, and match metadata, or `null` when no match is found.
 */
function lookupChannelSmart(cleanName, countryScopeKey) {
    if (!cleanName) return null;

    // ---- Tier 1: exact + alias ----
    const Direct = lookupChannel(cleanName.replace(/[^a-z0-9]/g, ''), countryScopeKey);
    if (Direct) return Direct;

    const toks = tokenize(cleanName, true);
    if (!toks.length) return null;
    const { sortedKey } = tokensToKeys(toks);

    // ---- Tier 2: token-set exact (order-insensitive) ----
    const tokEntries = tokenIndex.get(sortedKey);
    if (tokEntries && tokEntries.length) {
        if (countryScopeKey && countryScopeKey !== 'global') {
            const scoped = tokEntries.find(e => e.country === countryScopeKey || e.country === '');
            if (scoped) return { ...buildMatchResult(scoped), fuzzy: true, match: 'token' };
        } else if (tokEntries.length === 1 || new Set(tokEntries.map(e => e.country)).size <= 1) {
            // Unscoped: only safe to return a specific entry when every
            // candidate sharing this exact token set agrees on country (no
            // real ambiguity) — same principle as the exact-match tier's
            // ambiguousNames guard. Multiple distinct countries with no
            // scope to disambiguate means a "confident" pick here would be
            // an arbitrary guess, so fall through to the more conservative
            // Tier 3/4 checks instead.
            return { ...buildMatchResult(tokEntries[0]), fuzzy: true, match: 'token' };
        }
    }

    // ---- Tier 3: token-subsequence within the first-token bucket ----
    // Bucketed by leading token so we only examine candidates sharing the
    // query's first token — cheap and selective ("CNN Intl" only touches CNN*).
    // Oversized buckets (single-letter tokens like "m", "tv" gather thousands
    // of entries) are capped so a handful of degenerate names can't turn a
    // 47-second parse into a minutes-long stall.
    // Extend: when the query literally carries a brand token (e.g. "movistar"),
    // ALSO scan the brand's own bucket — entries like "Vamos por Movistar+" list
    // "movistar" as their leading token after transform, even if the bucket key
    // is "vamos". This catches "m vamos" → "Vamos por Movistar+".
    if (tokenByFirst) {
        const first = toks[0];
        const brandsToScan = new Set([first]);
        // An alias-expanded brand token ("movistar" from "m") may not be the
        // query's first token for reordered playlist names; add it explicitly.
        if (first !== 'movistar' && toks.includes('movistar')) brandsToScan.add('movistar');
        // Ordered subsequence for single-brand queries; ORDER-INSENSITIVE
        // subset when the query carries the brand token ("m vamos" = [movistar,
        // vamos] against "Vamos por Movistar+" = [vamos, movistar, plus]).
        const orderSensitive = !toks.includes('movistar');
        for (const brand of brandsToScan) {
            const bucket = tokenByFirst.get(brand) || [];
            const scanLimit = bucket.length > MAX_T3_SCAN ? MAX_T3_SCAN : bucket.length;
            for (let i = 0; i < scanLimit; i++) {
                const entry = bucket[i];
                if (countryScopeKey && countryScopeKey !== 'global' && entry.country && entry.country !== countryScopeKey) continue;
                const candToks = tokenize(entry.name, false);
                if (candToks.length < toks.length) continue;
                if (orderSensitive ? isSubsequence(toks, candToks) : isTokenSubset(toks, candToks)) {
                    if (isRegionConflicting(entry.name, countryScopeKey)) continue;
                    return { ...buildMatchResult(entry), fuzzy: true, matchFuzzy: 'subsequence' };
                }
            }
        }
    }

    // ---- Tier 4: Fuse fuzzy (fallback, conservative) ----
    // Prefilter: if the query's leading token never appears as a leading token
    // in any indexed entry, no fuse hit is plausible — skip the ~39k scan.
    // This is the hot path for the ~80% of playlist names that miss every tier;
    // the full index search dominated parse time on large playlists.
    if (!leadingTokens.has(toks[0])) return null;
    const fuzzy = lookupChannelFuzzy(cleanName.replace(/[^a-z0-9]/g, ''), countryScopeKey, toks[0]);
    if (fuzzy) return fuzzy;

    return null;
}

/**
 * Determines whether a country code is present in the refreshed country-code index.
 * @param {string} code - The country code to validate.
 * @return {boolean} `true` if the code is valid, `false` otherwise.
 */
function isValidCountryCode(code) {
    if (!code) return false;
    return validCountryCodes.has(code.toLowerCase());
}

/**
 * Checks whether a string is a real iptv-org official channel id (e.g.
 * "SkySportsF1.uk"), independent of logo coverage. Used to validate an
 * officialId a client claims is a real iptv-org entry before trusting it —
 * see server.js's /api/community-match "direct iptv-org match" branch.
 * @param {string} officialId
 * @return {boolean}
 */
function isValidOfficialId(officialId) {
    if (!officialId) return false;
    return validOfficialIds.has(String(officialId).toLowerCase());
}

// --- Region/group scope resolution -------------------------------------------
// Provider playlists often nest countries under a region container
// ("EURO | GREECE", "LAME | MEXICO", "NAME | USA"). The bare-prefix matcher in
// iptvParser only recognizes a leading ISO code, so these fall through to
// scope 'global' and lose the country scoping iptv-org matching depends on.
// resolveGroupScope() recognizes the container and maps the INNER subgroup to
// its ISO code, so both iptv-org matching and smart grouping key correctly.

// Region container first-tokens -> the inner subgroup name is a country.
// 'name' is the provider's own wrapper (e.g. "NAME | USA"), matching the same
// EURO/LAME style rather than an English word.
const REGION_CONTAINERS = new Set(['euro', 'lame', 'name', 'asia', 'africa', 'mea', 'latam', 'panam', 'eur']);

// Country name -> ISO code, built from iptv-org's own countries.json on refresh
// (into countryNameToCode), PLUS explicit aliases for group adjectives/regionisms
// that are not country names ("RUSSIAN", "LATINO", "EX-YU"). Keys are kept
// readable; normalization happens at lookup via the same stripNonLetters both
// the refresh map and countryCodeFromName use.
const COUNTRY_NAME_ALIASES = {
    'russian': 'ru', 'russia': 'ru', 'moldova': 'md', 'belarus': 'by',
    'ukraine': 'ua', 'latino': 'mx', 'latin america': 'mx',
    'ex-yu': 'rs', 'yugoslavia': 'rs',
    'czechia': 'cz', 'slovakia': 'sk', 'cz & slovak': 'cz',
    'bosnia': 'ba', 'bosnia herzegovina': 'ba',
    'macedonia': 'mk', 'north macedonia': 'mk',
    'serbia': 'rs', 'croatia': 'hr', 'slovenia': 'si', 'montenegro': 'me',
    'albania': 'al', 'kosovo': 'xk', 'bulgaria': 'bg', 'romania': 'ro',
    'greece': 'gr', 'hungary': 'hu', 'poland': 'pl', 'czech': 'cz',
    'sweden': 'se', 'norway': 'no', 'denmark': 'dk', 'finland': 'fi',
    'iceland': 'is', 'ireland': 'ie', 'portugal': 'pt', 'spain': 'es',
    'france': 'fr', 'germany': 'de', 'italy': 'it', 'netherlands': 'nl',
    'belgium': 'be', 'switzerland': 'ch', 'austria': 'at',
    'peru': 'pe', 'chile': 'cl', 'argentina': 'ar', 'colombia': 'co',
    'ecuador': 'ec', 'uruguay': 'uy', 'paraguay': 'py', 'bolivia': 'bo',
    'venezuela': 've', 'caribbean': 'dm',
    // Common non-ISO-3166 spellings (group adjectives/regionisms that are not
    // the official ISO name) that providers use instead of the true code.
    'usa': 'us', 'america': 'us', 'united states': 'us',
    'uk': 'gb', 'united kingdom': 'gb', 'england': 'gb', 'britain': 'gb',
    'south korea': 'kr', 'korea': 'kr', 'north korea': 'kp',
    'taiwan': 'tw', 'vietnam': 'vn',
};
// Normalize alias keys once ("latin america" -> "latinamerica") so lookup can
// match subgroup names after the same non-letter stripping.
const COUNTRY_ALIASES_NORM = new Map();
for (const [name, code] of Object.entries(COUNTRY_NAME_ALIASES)) {
    COUNTRY_ALIASES_NORM.set(name.toLowerCase().replace(/[^a-z]/g, ''), code);
}

let countryNameToCode = null; /**
 * Resolves a country name, alias, or ISO code to its lowercase country code.
 * @param {string} name - The country name, alias, or ISO code to resolve.
 * @return {string|null} The lowercase country code, or `null` if no match exists.
 */

function countryCodeFromName(name) {
    if (!name) return null;
    const norm = name.toLowerCase().replace(/[^a-z]/g, '');
    if (countryNameToCode && countryNameToCode.has(norm)) return countryNameToCode.get(norm);
    if (COUNTRY_ALIASES_NORM.has(norm)) return COUNTRY_ALIASES_NORM.get(norm);
    // The subgroup may already BE an ISO code (e.g. "EURO | UK")
    if (isValidCountryCode(norm)) return norm;
    return null;
}

/**
 * Resolves a group title to a country scope and normalized display prefix.
 * @param {string} rawGroup - The raw group title, such as `US | Sports` or `EURO | GREECE`.
 * @return {{code: string|null, scope: string, prefix: string, rest: string}} The resolved country code, scope, display prefix, and remaining group text.
 */
function resolveGroupScope(rawGroup) {
    const raw = (rawGroup || '').trim();
    const out = { code: null, scope: 'global', prefix: '', rest: raw };
    if (!raw) return out;

    // Providers separate a leading code/container from the rest with a pipe,
    // dash, or colon MOST of the time, but some use a bare standalone "I"
    // (e.g. "SR I SERBIA") — presumably a typo/stand-in for "|". Recognize it
    // as an equivalent separator everywhere below, but only as its own
    // whole word (\bI\b) so it never eats a real word ending or starting in
    // "i" ("Israel", "India", "iSport"...).
    const SEP = '(?:[|\\-:]|\\bI\\b)';

    // Leading ISO code, either bare ("UK") or as a two-tier prefix ("US | Sports",
    // "ES - Laliga", "SR I SERBIA"). The bare form matters because providers scope
    // a whole group to one country with a single code ("UK", "US", "GR") and
    // iptv-org uses the spoken-language names ("UK" not "GB").
    const m = raw.match(new RegExp(`^([A-Za-z]{2,3})\\s*${SEP}\\s*(.*)$`));
    if (m) {
        const code = m[1].toLowerCase();
        const rest = m[2].trim();
        if (isValidCountryCode(code)) {
            // A short leading code can collide with an unrelated country's
            // real ISO code (classic case: "SR" is a provider's own shorthand
            // for "Srbija"/Serbia, but "sr" is ALSO the real ISO code for
            // Suriname). When the rest of the title spells out a full,
            // unambiguous country name that resolves to a DIFFERENT code,
            // that's a far stronger signal than the short leading token —
            // prefer it.
            const restCode = countryCodeFromName(rest);
            const finalCode = (restCode && restCode !== code) ? restCode : code;
            out.code = finalCode; out.scope = finalCode;
            out.prefix = finalCode.toUpperCase() + ' | ';
            out.rest = rest;
            return out;
        }
    }

    // Bare code with no rest: "UK", "GR". Only treat as a country scope if the
    // WHOLE group is exactly that code (so a 2-3 letter name that happens to be a
    // valid code, like "ABC", is not hijacked) — this mirrors iptvParser's
    // \b-boundary bare-code branch.
    if (/^[A-Za-z]{2,3}$/.test(raw)) {
        const code = raw.toLowerCase();
        if (isValidCountryCode(code)) {
            out.code = code; out.scope = code;
            out.prefix = code.toUpperCase() + ' | ';
            out.rest = raw;
            return out;
        }
    }

    // Region container: first token is a continent/region header, not a country.
    const r = raw.match(new RegExp(`^([A-Za-z]{3,})\\s*${SEP}\\s*(.*)$`));
    if (r) {
        const container = r[1].toLowerCase();
        if (REGION_CONTAINERS.has(container)) {
            const inner = countryCodeFromName(r[2] ? r[2].trim() : '');
            if (inner) {
                out.code = inner; out.scope = inner;
                out.prefix = inner.toUpperCase() + ' | ';
                out.rest = r[2].trim();
                return out;
            }
        }
    }

    // Last resort: no recognized separator/structure at all, but the group
    // title itself may just BE (or contain) a country name outright — e.g. a
    // bare "Serbia" group, or "Eurosport Serbia HD" with no separator. Scan
    // whole-string, then word-by-word (and adjacent word pairs, for
    // multi-word names like "United Kingdom"), preferring the longest match
    // so e.g. "North Macedonia" wins over "Macedonia" alone. Deliberately
    // name-based only (never a bare 2-3 letter code) — an unstructured scan
    // for short codes would be far too prone to false positives on ordinary
    // group text.
    const wholeHit = countryCodeFromName(raw);
    if (wholeHit) {
        out.code = wholeHit; out.scope = wholeHit;
        out.prefix = wholeHit.toUpperCase() + ' | ';
        out.rest = raw;
        return out;
    }
    const words = raw.split(/[^A-Za-z]+/).filter(Boolean);
    let bestHit = null, bestLen = 0;
    for (let i = 0; i < words.length; i++) {
        for (const span of [words.slice(i, i + 1), words.slice(i, i + 2), words.slice(i, i + 3)]) {
            if (span.length === 0) continue;
            const phrase = span.join(' ');
            if (phrase.length < 4) continue; // exclude bare 2-3 letter tokens here
            const hit = countryCodeFromName(phrase);
            if (hit && phrase.length > bestLen) { bestHit = hit; bestLen = phrase.length; }
        }
    }
    if (bestHit) {
        out.code = bestHit; out.scope = bestHit;
        out.prefix = bestHit.toUpperCase() + ' | ';
        out.rest = raw;
        return out;
    }

    // Still nothing: providers also commonly TRAIL the country code instead of
    // leading with it ("Eurosport UK", "ESPN US", "Sport DE"). Only trust the
    // very last word for this (not any interior word) to keep false-positive
    // risk low — an interior short word being an accidental valid code is far
    // more likely in ordinary group text than the last word being one.
    if (words.length >= 2) {
        const lastWord = words[words.length - 1].toLowerCase();
        if (lastWord.length <= 3 && isValidCountryCode(lastWord)) {
            out.code = lastWord; out.scope = lastWord;
            out.prefix = lastWord.toUpperCase() + ' | ';
            out.rest = raw;
            return out;
        }
    }

    return out;
}

/**
 * Refreshes channel metadata immediately and schedules recurring daily refreshes.
 */
function startAutoRefresh() {
    refresh();
    setInterval(refresh, REFRESH_INTERVAL);
}

module.exports = {
    lookupChannel,
    lookupChannelFuzzy,
    lookupChannelSmart,
    isValidCountryCode,
    isValidOfficialId,
    resolveGroupScope,
    startAutoRefresh,
    get lastRefreshed() { return lastRefreshed; },
    // Read-only access to the current officialId -> logo URL map, used by the
    // background prewarm to iterate the full iptv-org set without mutating state.
    getChannelLogos() { return channelIdToLogo; }
};
