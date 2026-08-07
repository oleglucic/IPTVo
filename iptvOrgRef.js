const axios = require('axios');
const Fuse = require('fuse.js');

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

let nameToChannel = new Map();
let nameCountryToChannel = new Map(); // key: "${normalizedName}|${countryCode}"
let channelIdToLogo = new Map();
let validCountryCodes = new Set();
let fuseIndex = null;
let lastRefreshed = 0;

function normalize(str) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function refresh() {
    try {
        const [channelsRes, logosRes, countriesRes] = await Promise.all([
            axios.get(CHANNELS_URL, { timeout: 15000 }),
            axios.get(LOGOS_URL, { timeout: 15000 }),
            axios.get(COUNTRIES_URL, { timeout: 15000 })
        ]);

        const newNameMap = new Map();
        const newNameCountryMap = new Map();
        for (const ch of channelsRes.data) {
            if (ch.closed) continue;
            const names = [ch.name, ...(ch.alt_names || [])];
            for (const n of names) {
                const key = normalize(n);
                const countryLower = (ch.country || '').toLowerCase();
                const entry = { id: ch.id, name: ch.name, country: countryLower, officialId: ch.id };
                if (key && !newNameMap.has(key)) {
                    newNameMap.set(key, entry);
                }
                // Store country-specific entry (may overwrite if same key+country from different alias, that's fine)
                newNameCountryMap.set(`${key}|${countryLower}`, entry);
            }
        }

        const newLogoMap = new Map();
        for (const logo of logosRes.data) {
            if (logo.channel && !newLogoMap.has(logo.channel)) {
                newLogoMap.set(logo.channel, logo.url);
            }
        }

        const newCountrySet = new Set(countriesRes.data.map(c => c.code.toLowerCase()));

        const fuseList = [...newNameMap.entries()].map(([key, val]) => ({ key, ...val }));
        const newFuseIndex = new Fuse(fuseList, { keys: ['key'], threshold: 0.25, includeScore: true });

        nameToChannel = newNameMap;
        nameCountryToChannel = newNameCountryMap;
        channelIdToLogo = newLogoMap;
        validCountryCodes = newCountrySet;
        fuseIndex = newFuseIndex;
        lastRefreshed = Date.now();

        console.log(`[iptv-org] Refreshed: ${nameToChannel.size} name entries, ${channelIdToLogo.size} logos, ${validCountryCodes.size} country codes.`);
    } catch (e) {
        console.error('[iptv-org] Refresh failed, keeping previous data:', e.message);
    }
}

/**
 * Lookup channel by name and optional country scope.
 * @param {string} rawName - The raw channel name from playlist
 * @param {string} [countryScopeKey] - Optional country code like 'us', 'uk' (lowercase)
 * @returns {Object|null} Match object with countryScopeKey, canonicalName, logo, officialId
 */
function lookupChannel(rawName, countryScopeKey) {
    const key = normalize(rawName);
    let match = null;
    if (countryScopeKey) {
        // Try name+country specific map
        match = nameCountryToChannel.get(`${key}|${countryScopeKey}`);
    }
    // Fallback to name-only map if not found or no countryScopeKey provided
    if (!match && (!countryScopeKey || countryScopeKey === 'global')) {
        match = nameToChannel.get(key);
    }
    if (match) {
        // Only log when match found to reduce noise
        console.log(`[iptv-org] lookupChannel: match for "${rawName}"${countryScopeKey ? ` country:${countryScopeKey}` : ''} -> ${match.name} (id: ${match.id})`);
        return {
            countryScopeKey: match.country || 'global',
            canonicalName: match.name,
            logo: channelIdToLogo.get(match.id) || null,
            officialId: match.officialId
        };
    }
    return null;
}

/**
 * Fuzzy fallback for names that don't exact-match (typos, abbreviations,
 * slightly different formatting - e.g. "hbo2" vs iptv-org's "HBO 2").
 * Conservative threshold: only accepts near-exact matches to avoid
 * confidently assigning the wrong channel identity.
 * @param {string} rawName - The raw channel name from playlist
 * @param {string} [countryScopeKey] - Optional country code to filter results
 * @returns {Object|null} Match object with fuzzy flag
 */
function lookupChannelFuzzy(rawName, countryScopeKey) {
    if (!fuseIndex) return null;
    const key = normalize(rawName);
    if (key.length < 4) return null;
    const results = fuseIndex.search(key, { limit: 5 }); // get a few candidates to filter by country
    if (!results.length) {
        return null;
    }
    // Find first result that matches country (if countryScopeKey provided)
    for (const result of results) {
        if (result.score > 0.2) continue; // still enforce threshold
        const match = result.item;
        if (countryScopeKey) {
            if (match.country !== countryScopeKey) continue;
        }
        // Found a match that satisfies country constraint
        console.log(`[iptv-org] lookupChannelFuzzy: fuzzy match for "${rawName}"${countryScopeKey ? ` country:${countryScopeKey}` : ''} -> ${match.name} (id: ${match.id}) score: ${result.score}`);
        return {
            countryScopeKey: match.country || 'global',
            canonicalName: match.name,
            logo: channelIdToLogo.get(match.id) || null,
            officialId: match.officialId,
            fuzzy: true,
            fuzzyScore: result.score
        };
    }
    // No match satisfying country constraint
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