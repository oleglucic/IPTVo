const axios = require('axios');
const Fuse = require('fuse.js');

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

// Single combined exact-match Map: key = "${normalizedName}|${countryCode}"
// countryCode = '' for global (no country) entries
let exactMatchMap = new Map();
let channelIdToLogo = new Map();
let validCountryCodes = new Set();
let fuseIndex = null;
let fuseList = null;
let lastRefreshed = 0;

// Simple LRU cache for normalize() - max 5000 entries
const normalizeCache = new Map();
const NORMALIZE_CACHE_MAX = 5000;

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

async function refresh() {
    try {
        const [channelsRes, logosRes, countriesRes] = await Promise.all([
            axios.get(CHANNELS_URL, { timeout: 15000 }),
            axios.get(LOGOS_URL, { timeout: 15000 }),
            axios.get(COUNTRIES_URL, { timeout: 15000 })
        ]);

        const newExactMap = new Map();
        const newFuseList = [];

        for (const ch of channelsRes.data) {
            if (ch.closed) continue;
            const names = [ch.name, ...(ch.alt_names || [])];
            const countryLower = (ch.country || '').toLowerCase();
            const officialId = ch.id; // format: "ChannelName.countrycode"
            const entry = { officialId, name: ch.name, country: countryLower, logo: null };

            for (const n of names) {
                const key = normalize(n);
                if (!key) continue;

                // Composite key: "normalizedName|countryCode"
                const compositeKey = `${key}|${countryLower}`;
                if (!newExactMap.has(compositeKey)) {
                    newExactMap.set(compositeKey, entry);
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

        // Logos
        const newLogoMap = new Map();
        for (const logo of logosRes.data) {
            if (logo.channel && !newLogoMap.has(logo.channel)) {
                newLogoMap.set(logo.channel, logo.url);
            }
        }

        // Countries
        const newCountrySet = new Set(countriesRes.data.map(c => c.code.toLowerCase()));

        // Build Fuse index (lazy - only when needed, but we'll build it now for consistency)
        const newFuseIndex = new Fuse(newFuseList, {
            keys: ['key'],
            threshold: 0.25,
            includeScore: true,
            minMatchCharLength: 3,
            ignoreLocation: true,
            distance: 1000
        });

        exactMatchMap = newExactMap;
        channelIdToLogo = newLogoMap;
        validCountryCodes = newCountrySet;
        fuseIndex = newFuseIndex;
        fuseList = newFuseList;
        lastRefreshed = Date.now();

        console.log(`[iptv-org] Refreshed: ${exactMatchMap.size} exact entries, ${channelIdToLogo.size} logos, ${validCountryCodes.size} countries, ${fuseList.length} fuse entries.`);
    } catch (e) {
        console.error('[iptv-org] Refresh failed, keeping previous data:', e.message);
    }
}

/**
 * Exact lookup by cleaned name and optional country scope.
 * @param {string} cleanName - Already normalized channel name (lowercase, alphanumeric only)
 * @param {string} [countryScopeKey] - Optional country code like 'us', 'gb' (lowercase)
 * @returns {Object|null} Match object with countryScopeKey, canonicalName, logo, officialId
 */
function lookupChannel(cleanName, countryScopeKey) {
    if (!cleanName) return null;

    // Try country-specific first
    if (countryScopeKey) {
        const match = exactMatchMap.get(`${cleanName}|${countryScopeKey}`);
        if (match) {
            return buildMatchResult(match);
        }
    }

    // Fallback to global (no country)
    const globalMatch = exactMatchMap.get(`${cleanName}|`);
    if (globalMatch) {
        return buildMatchResult(globalMatch);
    }

    return null;
}

function buildMatchResult(match) {
    return {
        countryScopeKey: match.country || 'global',
        canonicalName: match.name,
        logo: channelIdToLogo.get(match.officialId) || null,
        officialId: match.officialId
    };
}

/**
 * Fuzzy fallback for names that don't exact-match.
 * Conservative: only accepts near-exact matches to avoid wrong assignments.
 * @param {string} cleanName - Already normalized channel name
 * @param {string} [countryScopeKey] - Optional country code to filter results
 * @returns {Object|null} Match object with fuzzy flag
 */
function lookupChannelFuzzy(cleanName, countryScopeKey) {
    if (!fuseIndex || !cleanName || cleanName.length < 4) return null;

    const results = fuseIndex.search(cleanName, { limit: 8 });
    if (!results.length) return null;

    for (const result of results) {
        if (result.score > 0.2) continue; // enforce conservative threshold
        const match = result.item;

        // Country filtering
        if (countryScopeKey && match.country !== countryScopeKey) continue;

        return {
            countryScopeKey: match.country || 'global',
            canonicalName: match.name,
            logo: channelIdToLogo.get(match.officialId) || null,
            officialId: match.officialId,
            fuzzy: true,
            fuzzyScore: result.score
        };
    }
    return null;
}

function isValidCountryCode(code) {
    if (!code) return false;
    return validCountryCodes.has(code.toLowerCase());
}

function startAutoRefresh() {
    refresh();
    setInterval(refresh, REFRESH_INTERVAL);
}

module.exports = {
    lookupChannel,
    lookupChannelFuzzy,
    isValidCountryCode,
    startAutoRefresh,
    get lastRefreshed() { return lastRefreshed; }
};