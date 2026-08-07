const axios = require('axios');
const Fuse = require('fuse.js');

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

let nameToChannel = new Map();
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
        for (const ch of channelsRes.data) {
            if (ch.closed) continue;
            const names = [ch.name, ...(ch.alt_names || [])];
            for (const n of names) {
                const key = normalize(n);
                if (key && !newNameMap.has(key)) {
                    newNameMap.set(key, { id: ch.id, name: ch.name, country: (ch.country || '').toLowerCase(), officialId: ch.id });
                }
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
        channelIdToLogo = newLogoMap;
        validCountryCodes = newCountrySet;
        fuseIndex = newFuseIndex;
        lastRefreshed = Date.now();

        console.log(`[iptv-org] Refreshed: ${nameToChannel.size} name entries, ${channelIdToLogo.size} logos, ${validCountryCodes.size} country codes.`);
    } catch (e) {
        console.error('[iptv-org] Refresh failed, keeping previous data:', e.message);
    }
}

function lookupChannel(rawName) {
    const key = normalize(rawName);
    const match = nameToChannel.get(key);
    if (!match) return null;
    return {
        countryScopeKey: match.country || 'global',
        canonicalName: match.name,
        logo: channelIdToLogo.get(match.id) || null,
        officialId: match.officialId
    };
}

/**
 * Fuzzy fallback for names that don't exact-match (typos, abbreviations,
 * slightly different formatting - e.g. "hbo2" vs iptv-org's "HBO 2").
 * Conservative threshold: only accepts near-exact matches to avoid
 * confidently assigning the wrong channel identity.
 */
function lookupChannelFuzzy(rawName) {
    if (!fuseIndex) return null;
    const key = normalize(rawName);
    if (key.length < 4) return null;
    const results = fuseIndex.search(key, { limit: 1 });
    if (!results.length || results[0].score > 0.2) return null;
    const match = results[0].item;
    return {
        countryScopeKey: match.country || 'global',
        canonicalName: match.name,
        logo: channelIdToLogo.get(match.id) || null,
        officialId: match.officialId,
        fuzzy: true,
        fuzzyScore: results[0].score
    };
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