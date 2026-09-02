/**
 * epgHub — central multi-source EPG (task: auto EPG matching).
 *
 * Fetches free XMLTV programme sources (multiple complementary providers to avoid
 * a single point of failure), normalizes their channel ids to iptv-org officialIds,
 * merges them into the central epg_programs table, and warms a generation-stamped
 * Redis cache in front of it (so user requests hit Redis, not the DB, and the cache
 * is valid exactly as long as the DB's data lasts).
 *
 * Sources are registered in the epg_sources registry table (extensible by users);
 * every URL is SSRF-guarded via iptvParser.isSafeUrl / revalidateResponseUrl.
 * A single broken source is isolated — it only increments its error_count and
 * never takes down the hub.
 */
const axios = require('axios');
const zlib = require('zlib');
const sax = require('sax');
const { Readable } = require('stream');
const { isSafeUrl, revalidateResponseUrl } = require('./iptvParser');
const { lookupChannelSmart, lookupChannel, isValidCountryCode } = require('./iptvOrgRef');
const {
    saveEpgPrograms, listEpgSources, setEpgSourceStatus, upsertEpgSource, pruneEpgPrograms
} = require('./db');
const {
    saveEpgCache, getHubGeneration, bumpGeneration, setHubState
} = require('./redisCache');
const log = require('./logger').for('epgHub');

// The XMLTV sources key programmes by their own channel ids (e.g.
// "sky.sports.news.uk"), but users look up programmes by their provider
// channel's canonical iptv-org id (e.g. "uk_SkySportsNews.uk"). On the write
// side we therefore canonicalize each source id to its iptv-org official id
// and store the same programmes under BOTH keys: the raw `global_<sourceId>`
// and the canonical `global_<officialId>`, so scoped user lookups find them.
let canonicalIdCache = null; // Map<sourceIdLower, {official, base}|null>
/**
 * Provides the cached canonical channel ID mappings.
 * @returns {Map<string, {official: string, base: string}|null>} The canonical ID cache.
 */
function getCanonicalCache() {
    if (!canonicalIdCache) canonicalIdCache = new Map();
    return canonicalIdCache;
}
// iptvOrgRef.lastRefreshed is a live getter; read it on each use so a snapshot
// taken while the indexes were still loading can't pin the retry loops.
const iptvOrgRef = require('./iptvOrgRef');
/**
 * Checks whether iptv-org reference data has been refreshed.
 * @return {boolean} `true` if reference data has been refreshed, `false` otherwise.
 */
function getIptvOrgReady() {
    return iptvOrgRef.lastRefreshed > 0;
}

/**
 * Maps a source channel identifier to its canonical iptv-org identifiers.
 * @param {string} sourceId - The source channel identifier to resolve.
 * @return {{official: string, base: string|null}|null} The canonical lowercase ID and its country-independent base ID, or `null` when no match is found.
 */
async function resolveCanonicalSourceId(sourceId) {
    const key = String(sourceId).toLowerCase().trim();
    if (!key) return null;
    const cache = getCanonicalCache();
    if (cache.has(key)) return cache.get(key);
    let official = null;
    let base = null;
    try {
        // dotted id: human name, match against iptv-org reference
        // Extract and strip valid country suffix, then clean the name
        const lastDot = key.lastIndexOf('.');
        let scope = '';
        let nameToClean = key;
        if (lastDot > 0) {
            const suffix = key.slice(lastDot + 1);
            if (isValidCountryCode(suffix)) {
                scope = suffix;
                nameToClean = key.slice(0, lastDot);
            }
        }
        // Strip bracketed/parenthetical junk (e.g. the "(RS)" in
        // "Viasat.Kino.(RS).exTV1000.rs") BEFORE cleaning — left in, it
        // either breaks normalizeSourceId's own regex further up the
        // pipeline or survives into the alnum bridge key below as noise
        // that a synthesized channel id (which never has such junk) would
        // never independently produce, silently preventing the match.
        nameToClean = nameToClean.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
        const clean = nameToClean
            .replace(/\b(hd|fhd|uhd|4k|sd|hdr|plus|dummy|emu)\b/gi, '')
            .replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
        if (clean) {
            // lookups don't throw before the reference indexes finish loading
            const bySmart = lookupChannelSmart(clean, scope);
            const m = (bySmart && bySmart.officialId) ? bySmart : lookupChannel(clean, scope);
            if (m && m.officialId) official = String(m.officialId).toLowerCase();
        }
        if (official) {
            const cc = /\.([a-z]{2})$/i.exec(official);
            if (cc && isValidCountryCode(cc[1].toLowerCase())) {
                base = official.slice(0, -cc[0].length);
            }
        } else if (clean) {
            // No iptv-org match anywhere (the source's own channel simply
            // isn't in iptv-org's database at all — a real, fairly common
            // gap, not a matching failure). Still produce a fully alnum,
            // separator-free bridge key from the source's OWN cleaned
            // name+scope: this is exactly the same "PascalCaseName.cc"
            // shape (lowercased here) that iptvParser.js's
            // synthesizeIptvOrgStyleId produces for a channel with no
            // iptv-org match, so the two sides meet in the middle without
            // any change needed on the read side (epgLookupKeys already
            // strips a channel's own id down to this same form to build its
            // bridge key). This is what lets EPG data for a channel like
            // "FilmBox Arthouse" (no iptv-org RS entry) still reach a
            // channel synthesized as iptvo_FilmboxArthouse.rs.
            base = clean.replace(/[^a-z0-9]/g, '') + (scope ? `.${scope}` : '');
        }
    } catch (_) { /* no match -> null */ }
    const result = (official || base) ? { official, base } : null;
    // Never pin a negative/fallback-only result while the iptv-org reference
    // indexes are still loading — a cold matcher maps everything to null
    // (or an unnecessary fallback base), and caching that would permanently
    // block this source id from ever gaining its real canonical alias once
    // the reference finishes loading. A genuine `official` match can be
    // cached immediately either way.
    if (official || getIptvOrgReady()) cache.set(key, result);
    return result;
}

const CONCURRENCY = Math.min(Math.max(parseInt(process.env.EPG_HUB_CONCURRENCY || '3', 10) || 3, 1), 16);

let running = false;

// Seed the source registry with the verified free providers. kind/region drive
// which channels a source can cover; 'general'/'aggregate' span all regions.
const DEFAULT_SOURCES = [
    { source: 'epgshare01-all', kind: 'aggregate', url: 'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz', region: 'global', notes: 'epgshare01 aggregate (192MB, iptv-org-style ids)' },
    { source: 'epgshare01-es', kind: 'country', url: 'https://epgshare01.online/epgshare01/epg_ripper_ES1.xml.gz', region: 'es', notes: 'Spain' },
    { source: 'epgshare01-us', kind: 'country', url: 'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz', region: 'us', notes: 'USA' },
    { source: 'imjhnz', kind: 'aggregate', url: 'https://i.mjh.nz/all/epg.xml', region: 'global', notes: 'i.mjh.nz broad aggregate' },
    { source: 'globetvapp', kind: 'country', url: 'https://raw.githubusercontent.com/globetvapp/epg/main/Usa/usa1.xml.gz', region: 'us', notes: 'globetvapp USA guide (GitHub raw)' },
    // Open-EPG (open-epg.com), per-country XMLTV files. Their site notes an
    // ongoing internal migration ("MERGE IS HAPPENING") as of this writing,
    // so treat these as best-effort: a broken URL fails closed (isolated
    // per-source, logged, error_count incremented) rather than affecting
    // anything else — if one of these starts 404ing after their migration
    // finishes, check open-epg.com/app/epgguide.php for the current filename
    // and update the row via upsertEpgSource / the epg_sources table.
    { source: 'openepg-uk', kind: 'country', url: 'https://www.open-epg.com/files/unitedkingdom.xml.gz', region: 'uk', notes: 'Open-EPG United Kingdom' },
    { source: 'openepg-ie', kind: 'country', url: 'https://www.open-epg.com/files/ireland.xml.gz', region: 'ie', notes: 'Open-EPG Ireland' },
    { source: 'openepg-in', kind: 'country', url: 'https://www.open-epg.com/files/india.xml.gz', region: 'in', notes: 'Open-EPG India' },
];

/** Seed the epg_sources registry once (idempotent upsert); isolates per-source failures. */
async function seedSources() {
    for (const s of DEFAULT_SOURCES) {
        try {
            await upsertEpgSource(s);
        } catch (e) {
            log.error(`failed to seed source ${s.source}:`, e.message);
        }
    }
}

/**
 * Reads the first chunk of a stream, settling on EOF/error (an empty-body feed
 * would otherwise leave the bare `once('data')` promise pending forever).
 * @param {stream.Readable} stream - The stream to read from.
 * @return {Promise<Buffer|undefined>} The first chunk, or `undefined` when the stream ends or errors before producing data.
 */
function firstStreamChunk(stream) {
    const settled = new Promise((resolve) => {
        stream.once('data', (c) => resolve(c));
        stream.once('end', () => resolve(undefined));
        stream.once('error', () => resolve(undefined));
    });
    return settled;
}

/**
 * Fetches and parses an XMLTV feed, grouping programmes by their normalized raw channel IDs.
 * @param {string} url - The XMLTV feed URL.
 * @returns {Promise<{byChannel: Map<string, Array<{title: string, desc: string, start: number, stop: number}>>, spanMs: number}>} The grouped programmes and the feed's overall programme time span in milliseconds.
 * @throws {Error} If the URL is unsafe or the feed cannot be fetched, decompressed, or parsed.
 */
async function fetchSourceRaw(url) {
    if (!isSafeUrl(url)) throw new Error('Unsafe EPG source URL');
    const res = await axios({ method: 'get', url, responseType: 'stream', headers: { 'Accept-Encoding': 'gzip,deflate', 'User-Agent': 'Mozilla/5.0 (compatible; IPTVo/1.0)' }, timeout: 300000 });
    revalidateResponseUrl(res, res.data);
    let rawStream = res.data;
    const firstChunk = await firstStreamChunk(rawStream);
    let finalizedStream;
    if (firstChunk && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b) {
        finalizedStream = Readable.from((async function* () { yield firstChunk; for await (const c of rawStream) yield c; })()).pipe(zlib.createGunzip());
    } else {
        finalizedStream = Readable.from((async function* () { if (firstChunk) yield firstChunk; for await (const c of rawStream) yield c; })());
    }
    return new Promise((resolve, reject) => {
        const saxStream = sax.createStream(true, { trim: true, normalize: true });
        const byChannel = new Map();
        let cur = null, text = '';
        let minStart = Infinity, maxStop = 0, progs = 0;
        saxStream.on('opentag', (n) => {
            if (n.name === 'programme') {
                cur = { channel: (n.attributes.channel || '').toLowerCase().trim(), start: parseXmlDate(n.attributes.start), stop: parseXmlDate(n.attributes.stop) };
            } else if (n.name === 'channel') {
                cur = { isChannel: true, id: (n.attributes.id || '').toLowerCase().trim() };
            }
            text = '';
        });
        saxStream.on('text', (t) => { if (cur) text += t; });
        saxStream.on('closetag', (tag) => {
            if (!cur) return;
            if (cur.isChannel) { cur = null; text = ''; return; }
            if (tag === 'title') cur.title = text.trim();
            else if (tag === 'desc') cur.desc = text.trim();
            else if (tag === 'programme') {
                if (cur.channel) {
                    let arr = byChannel.get(cur.channel);
                    if (!arr) { arr = []; byChannel.set(cur.channel, arr); }
                    arr.push({ title: cur.title || 'Unknown', desc: cur.desc || '', start: cur.start, stop: cur.stop });
                    if (cur.start > 0 && cur.start < minStart) minStart = cur.start;
                    if (cur.stop > maxStop) maxStop = cur.stop;
                    progs++;
                }
                cur = null; text = '';
            }
        });
        saxStream.on('end', () => resolve({ byChannel, spanMs: progs ? (maxStop - minStart) : 0 }));
        saxStream.on('error', (e) => reject(e));
        finalizedStream.on('error', reject);
        finalizedStream.pipe(saxStream);
    });
}

/**
 * Converts an XMLTV timestamp to Unix time in milliseconds.
 * @param {string} x - The XMLTV timestamp.
 * @return {number} The timestamp in milliseconds, or `0` for an invalid or missing value.
 */
function parseXmlDate(x) {
    if (!x || x.length < 14) return 0;
    try {
        const offset = x.substring(15).trim() || '+0000';
        const f = offset.length === 5 ? `${offset.substring(0,3)}:${offset.substring(3,5)}` : 'Z';
        const iso = `${x.substring(0,4)}-${x.substring(4,6)}-${x.substring(6,8)}T${x.substring(8,10)}:${x.substring(10,12)}:${x.substring(12,14)}${f}`;
        return new Date(iso).getTime();
    } catch { return 0; }
}

/**
 * Normalize a raw channel identifier to a canonical country-qualified ID.
 * @param {string} rawId - The source channel identifier.
 * @return {string|null} The normalized identifier if it uses a supported country suffix, or `null` otherwise.
 */
function normalizeSourceId(rawId) {
    if (!rawId) return null;
    const r = rawId.toLowerCase().trim().replace(/^['"#]+/, '').replace(/\s+/g, ' ');
    // name.cc form. Previously this only accepted a fixed ~46-country
    // shortlist, which silently dropped every programme for a channel id
    // ending in any of the ~200 other real country codes (e.g. "GloboSP.br",
    // "Caracol.co", "SkySportsF1.ie", "ESPN.pe") before it ever reached
    // storage — the same class of bug as the addon manifest's idPrefixes gap.
    // Delegate to the same isValidCountryCode() the rest of the matching
    // pipeline already trusts, so this list can never drift out of sync
    // again. 'net' is kept as an explicit extra suffix (not a country code)
    // for backward compatibility with sources that already used it.
    //
    // Validate against a parenthetical/bracket-stripped copy — some sources
    // embed extra tags mid-id (e.g. "Viasat.Kino.(RS).exTV1000.rs"), and the
    // allowed character class below never included "(" ")", so the whole id
    // was rejected outright and its programme data silently dropped before
    // ever reaching storage. `r` itself (the stored/returned key) is left
    // untouched — this only fixes the over-strict validation gate.
    const forValidation = r.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    const m = /^([a-z0-9 .'-]+)\.([a-z]{2,3})$/i.exec(forValidation);
    if (m && (m[2] === 'net' || isValidCountryCode(m[2]))) {
        return r;
    }
    return null;
}

/**
 * Combines programme listings from multiple sources for a channel.
 * @param {Array<{source: string, spanMs: number, programs: Array}>} candidates - Source listings to merge, ordered by programme count.
 * @return {Array} The merged programmes with duplicate start-time and title pairs removed.
 */
function mergeForChannel(candidates) {
    // candidates: [{source, spanMs, programs}]
    if (!candidates || candidates.length === 0) return [];
    // Prefer the candidate with the most programmes / longest span. Copy avoids
    // mutating the caller's array (the list also drives source attribution).
    const sorted = [...candidates].sort((a, b) => (b.programs ? b.programs.length : 0) - (a.programs ? a.programs.length : 0));
    const seen = new Set();
    const out = [];
    for (const c of sorted) {
        if (!c.programs) continue;
        for (const p of c.programs) {
            const k = `${p.start}|${p.title}`;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(p);
        }
    }
    return out;
}

/**
 * Runs a complete EPG ingestion cycle.
 *
 * @return {{status: string, fetched?: number, failed?: number, mergedChannels?: number, mergedPrograms?: number, generation?: number}} The cycle status and, when completed, processing statistics and generation number.
 */
async function run() {
    if (running) return { status: 'already-running' };
    running = true;
    try {
        const sources = await listEpgSources();
        const enabled = sources.filter(s => s.enabled !== false);
        if (enabled.length === 0) { log.info('No enabled sources.'); return { status: 'no-sources' }; }
        const channelBuckets = new Map(); // officialId -> [{source, programs}]
        let fetched = 0, failed = 0;
        let i = 0;
        await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
            while (i < enabled.length) {
                const idx = i++;
                const s = enabled[idx];
                try {
                    const { byChannel } = await fetchSourceRaw(s.url);
                    fetched++;
                    for (const [rawId, programs] of byChannel) {
                        const officialId = normalizeSourceId(rawId);
                        if (!officialId || !programs.length) continue;
                        if (!channelBuckets.has(officialId)) channelBuckets.set(officialId, []);
                        channelBuckets.get(officialId).push({ source: s.source, programs });
                    }
                    await setEpgSourceStatus(s.source, { last_fetch: Date.now(), last_success: Date.now(), error_count: 0 });
                } catch (e) {
                    failed++;
                    log.error(`source ${s.source} failed: ${e.message}`);
                    await setEpgSourceStatus(s.source, { last_fetch: Date.now(), error_count: (s.error_count || 0) + 1 });
                }
            }
        }));

        // Merge per-channel, write to central store, and mark the hub generation
        // stale so the Redis cache is rebuilt from the fresh DB data. Reserve the
        // new generation atomically up front — every cache entry below is stamped
        // with exactly that value, so a concurrent (cluster) cycle can never
        // publish entries under a stale or guessed generation.
        let mergedChannels = 0, mergedPrograms = 0;
        const generation = await bumpGeneration(0); // advance + reserve the stamp value
        // Track base keys already written to prevent overwriting with later variants
        const baseKeysWritten = new Set();
        for (const [officialId, candidates] of channelBuckets) {
            const merged = mergeForChannel(candidates);
            if (!merged.length) continue;
            // Raw source-id key (e.g. global_sky.sports.news.uk) always written;
            // when the source id resolves to an iptv-org official id also write
            // the canonical global_<official> key so scoped user lookups (e.g.
            // uk_SkySportsNews.uk -> global_skysportsnews.uk) can find the data.
            const channelKey = `global_${officialId}`;
            const canonical = await resolveCanonicalSourceId(officialId);
            // Attribute to the source contributing the most programmes (more
            // stable than candidates[0], whose order reflects insertion, not fit).
            const dominant = candidates.reduce((best, c) => (c.programs && c.programs.length > (best.programs ? best.programs.length : 0)) ? c : best, candidates[0]);
            // Store under the raw source-id key, the matched official key, and
            // the cc-stripped base key (so a .uk user channel finds .ie data for
            // the same brand). Dedupe keys whose forms coincide. `canonical.base`
            // may now be set even when `canonical.official` isn't — see
            // resolveCanonicalSourceId's no-iptv-org-match fallback — so the
            // official key must only be added when it's actually present.
            const storeKeys = new Set([channelKey]);
            if (canonical) {
                if (canonical.official) storeKeys.add(`global_${canonical.official}`);
                if (canonical.base) {
                    const baseKey = `global_${canonical.base}`;
                    // Only write base key once (first variant wins)
                    if (!baseKeysWritten.has(baseKey)) {
                        storeKeys.add(baseKey);
                        baseKeysWritten.add(baseKey);
                    }
                }
            }
            for (const storeKey of storeKeys) {
                await saveEpgPrograms(storeKey, dominant.source, merged);
                await saveEpgCache(storeKey, merged, generation);
            }
            mergedChannels++;
            mergedPrograms += merged.length;
        }
        setHubState(mergedPrograms).catch(() => {}); // publish final coverage (no re-advance)
        await pruneEpgPrograms();
        log.info(`cycle: fetched=${fetched} failed=${failed} mergedChannels=${mergedChannels} mergedPrograms=${mergedPrograms}`);
        return { status: 'done', fetched, failed, mergedChannels, mergedPrograms, generation: await getHubGeneration() };
    } finally {
        running = false;
    }
}

/**
 * Populates canonical and base channel aliases for existing EPG programme records.
 *
 * @return {Promise<{status: string, changed?: number, error?: string, reason?: string}>} The backfill result, including the number of records written when completed or failure details when it cannot proceed.
 */
async function backfillCanonicalAliases() {
    const { pool } = require('./db');
    if (!pool) return { status: 'no-pool' };
    // Wait for the iptv-org reference timestamps to be ready before matching
    // (retry until lastRefreshed > 0, ~15s apart, up to ~5 min). Read the live
    // getter each attempt — a snapshot taken while it was 0 would never update.
    for (let attempt = 0; attempt < 20 && !getIptvOrgReady(); attempt++) {
        await new Promise(r => setTimeout(r, 15000));
    }
    // If reference still not ready after all attempts, return distinct not-ready status
    if (!getIptvOrgReady()) {
        log.warn('backfill skipped: reference not ready after 20 attempts');
        return { status: 'skipped', reason: 'reference-not-ready' };
    }
    let changed = 0;
    let cursor = '';
    const pageSize = 500;
    try {
        // Keyset pagination, not OFFSET: this loop inserts canonical keys into
        // the same global_% set it pages, and a new key sorting before the next
        // offset would otherwise be skipped by subsequent pages.
        while (true) {
            const { rows } = await pool.query(
                `SELECT DISTINCT channel_key FROM epg_programs
                 WHERE channel_key LIKE 'global\\_%' ESCAPE '\\'
                   AND channel_key > $1
                 ORDER BY channel_key LIMIT $2`,
                [cursor, pageSize]
            );
            if (!rows || rows.length === 0) break;
            cursor = rows[rows.length - 1].channel_key;
            for (const r of rows) {
                const rawKey = r.channel_key;
                const sourceId = rawKey.replace(/^global_/, '');
                const canonical = await resolveCanonicalSourceId(sourceId);
                if (!canonical) continue;
                // Same official-may-be-null-while-base-is-set fix as the main
                // ingestion loop above.
                const targetKeys = new Set();
                if (canonical.official) targetKeys.add(`global_${canonical.official}`);
                if (canonical.base) targetKeys.add(`global_${canonical.base}`);
                for (const targetKey of targetKeys) {
                    if (targetKey === rawKey) continue;
                    const result = await pool.query(
                        `INSERT INTO epg_programs (channel_key, source, title, description, start_time, stop_time)
                         SELECT $1, source, title, description, start_time, stop_time
                         FROM epg_programs WHERE channel_key = $2
                         ON CONFLICT (channel_key, source, start_time) DO NOTHING`,
                        [targetKey, rawKey]
                    );
                    changed += (result && result.rowCount) || 0;
                }
            }
            log.info(`backfill aliases cursor=${cursor} written=${changed}...`);
        }
    } catch (e) {
        log.error(`backfill failed: ${e.message}`);
        return { status: 'error', error: e.message };
    }
    log.info(`backfill complete: canonical aliases written=${changed}`);
    return { status: 'done', changed };
}

module.exports = { run, seedSources, fetchSourceRaw, normalizeSourceId, mergeForChannel, resolveCanonicalSourceId, backfillCanonicalAliases };