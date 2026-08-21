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
const {
    saveEpgPrograms, listEpgSources, setEpgSourceStatus, upsertEpgSource, pruneEpgPrograms
} = require('./db');
const {
    saveEpgCache, getHubGeneration, bumpGeneration, setHubState
} = require('./redisCache');

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
];

/** Seed the epg_sources registry once (idempotent upsert); isolates per-source failures. */
async function seedSources() {
    for (const s of DEFAULT_SOURCES) {
        try {
            await upsertEpgSource(s);
        } catch (e) {
            console.error(`[epgHub] failed to seed source ${s.source}:`, sanitizeForLog(e.message));
        }
    }
}

function sanitizeForLog(msg) {
    return typeof msg === 'string' ? msg.replace(/:\/\/[^@\s]*@/, '://[REDACTED]@') : msg;
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
    // name.cc form
    if (/^[a-z0-9 .'-]+\.(us|uk|gb|es|de|fr|it|ca|au|nz|net|ae|ru|br|ar|mx|tr|in|gr|pt|nl|be|se|no|dk|fi|pl|cz|ro|bg|rs|hr|si|il|za|jp|kr|tw|th|ph|id|my|sg|hk|cn)$/i.test(r)) {
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
 * Executes a complete EPG ingestion cycle.
 *
 * @return {{status: string, fetched?: number, failed?: number, mergedChannels?: number, mergedPrograms?: number, generation?: number}} Cycle status and processing statistics, or an `already-running` or `no-sources` status.
 */
async function run() {
    if (running) return { status: 'already-running' };
    running = true;
    try {
        const sources = await listEpgSources();
        const enabled = sources.filter(s => s.enabled !== false);
        if (enabled.length === 0) { console.log('[epgHub] No enabled sources.'); return { status: 'no-sources' }; }
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
                    console.error(`[epgHub] source ${s.source} failed: ${e.message}`);
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
        for (const [officialId, candidates] of channelBuckets) {
            const merged = mergeForChannel(candidates);
            if (!merged.length) continue;
            const channelKey = `global_${officialId}`;
            // Attribute to the source contributing the most programmes (more
            // stable than candidates[0], whose order reflects insertion, not fit).
            const dominant = candidates.reduce((best, c) => (c.programs && c.programs.length > (best.programs ? best.programs.length : 0)) ? c : best, candidates[0]);
            await saveEpgPrograms(channelKey, dominant.source, merged);
            mergedChannels++;
            mergedPrograms += merged.length;
            await saveEpgCache(channelKey, merged, generation);
        }
        setHubState(mergedPrograms).catch(() => {}); // publish final coverage (no re-advance)
        await pruneEpgPrograms();
        console.log(`[epgHub] cycle: fetched=${fetched} failed=${failed} mergedChannels=${mergedChannels} mergedPrograms=${mergedPrograms}`);
        return { status: 'done', fetched, failed, mergedChannels, mergedPrograms, generation: await getHubGeneration() };
    } finally {
        running = false;
    }
}

module.exports = { run, seedSources, fetchSourceRaw, normalizeSourceId, mergeForChannel };