const axios = require('axios');

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const COUNTRIES_URL = 'https://iptv-org.github.io/api/countries.json';
const REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24h

let nameToChannel = new Map();   // normalized alt_name/name -> { id, name, country }
let channelIdToLogo = new Map(); // channel id -> logo url
let validCountryCodes = new Set();
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
                    newNameMap.set(key, { id: ch.id, name: ch.name, country: (ch.country || '').toLowerCase() });
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

        nameToChannel = newNameMap;
        channelIdToLogo = newLogoMap;
        validCountryCodes = newCountrySet;
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
        logo: channelIdToLogo.get(match.id) || null
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

module.exports = { lookupChannel, isValidCountryCode, startAutoRefresh, get lastRefreshed() { return lastRefreshed; } };