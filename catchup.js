// catchup.js
// Handles everything related to catch-up/recap: detecting which channels
// support it, building timeshift URLs, snapshotting EPG data into a
// persistent history (since XMLTV feeds are forward-looking only), and
// building the catch-up stream entries served alongside live streams.

const { saveEpgSnapshot, getEpgHistory } = require('./db');

/**
 * Extract catch-up eligibility from a raw M3U #EXTINF line.
 * Looks for tv_archive="1" plus tv_archive_duration or catchup-days.
 * @param {string} extinfLine - the raw #EXTINF line text
 * @returns {{ hasCatchup: boolean, catchupDays: number } | null}
 */
function extractM3uCatchupInfo(extinfLine) {
    const archiveMatch = extinfLine.match(/tv_archive=["']?1["']?/i);
    if (!archiveMatch) return null;
    const durationMatch = extinfLine.match(/tv_archive_duration=["']([^"']+)["']/i)
        || extinfLine.match(/catchup-days=["']([^"']+)["']/i);
    const days = durationMatch ? parseInt(durationMatch[1], 10) : 1;
    return { hasCatchup: true, catchupDays: isNaN(days) ? 1 : days };
}

/**
 * Extract catch-up eligibility from an Xtream get_live_streams stream object.
 * @param {object} stream
 * @returns {{ hasCatchup: boolean, catchupDays: number } | null}
 */
function extractXtreamCatchupInfo(stream) {
    const archive = stream.tv_archive === 1 || stream.tv_archive === '1';
    if (!archive) return null;
    const days = parseInt(stream.tv_archive_duration, 10);
    return { hasCatchup: true, catchupDays: isNaN(days) ? 1 : days };
}

/**
 * Build a timeshift catch-up URL from a channel's live stream URL.
 * Live URL pattern:    http://domain/live/{user}/{pass}/{streamId}.ext
 * Catch-up pattern:    http://domain/streaming/timeshift.php?username=X&password=Y&stream=ID&start=YYYY-MM-DD:HH-MM&duration=MIN
 * (Confirmed working pattern for Xtream-Codes/Stalker-style backends.)
 * @param {string} liveUrl
 * @param {number} startMs - program start time, epoch milliseconds
 * @param {number} durationMinutes
 * @returns {string | null}
 */
function buildCatchupUrl(liveUrl, startMs, durationMinutes) {
    const match = liveUrl.match(/^(https?:\/\/[^\/]+)\/live\/([^\/]+)\/([^\/]+)\/(\d+)\.\w+$/i);
    if (!match) return null;
    const [, domain, user, pass, streamId] = match;

    const d = new Date(startMs);
    const pad = (n) => String(n).padStart(2, '0');
    const start = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;

    return `${domain}/streaming/timeshift.php?username=${user}&password=${pass}&stream=${streamId}&start=${start}&duration=${Math.round(durationMinutes)}`;
}

/**
 * Build the list of catch-up stream entries for a channel, from recorded
 * EPG history (not the live XMLTV feed, which only covers now/upcoming).
 * @param {string} channelKey
 * @param {string} liveUrl - any one of the channel's live stream URLs, used to derive credentials/domain
 * @param {number} [hoursBack=48]
 * @returns {Promise<Array<{name: string, title: string, url: string}>>}
 */
async function getCatchupStreams(channelKey, liveUrl, hoursBack = 48) {
    const history = await getEpgHistory(channelKey, hoursBack);
    if (!history || history.length === 0) return [];

    // Most recent program first
    history.sort((a, b) => b.start_time - a.start_time);

    const entries = [];
    for (const p of history) {
        const durationMinutes = (p.stop_time - p.start_time) / 60000;
        if (durationMinutes <= 0) continue;

        const url = buildCatchupUrl(liveUrl, p.start_time, durationMinutes);
        if (!url) continue;

        const startDate = new Date(p.start_time);
        const stopDate = new Date(p.stop_time);
        const pad = (n) => String(n).padStart(2, '0');
        const timeLabel = `${pad(startDate.getUTCHours())}:${pad(startDate.getUTCMinutes())}-${pad(stopDate.getUTCHours())}:${pad(stopDate.getUTCMinutes())}`;

        entries.push({
            name: 'CATCHUP',
            title: `${p.title || 'Unknown Program'} (${timeLabel})`,
            url
        });
    }

    return entries;
}

/**
 * Snapshot all currently cached channels' EPG data into persistent history.
 * Intended to be called periodically (e.g. every 30 min) while the server
 * process stays warm, so history accumulates continuously over time.
 * @param {Map} userCaches - the in-memory cache map from iptvParser.js
 */
async function snapshotAllEpgToHistory(userCaches) {
    let totalSaved = 0;
    let channelsProcessed = 0;

    for (const [_configKey, ud] of userCaches.entries()) {
        if (!ud || ud.status !== 'ready' || !ud.epgData) continue;

        for (const [channelKey, programs] of Object.entries(ud.epgData)) {
            if (!Array.isArray(programs) || programs.length === 0) continue;
            await saveEpgSnapshot(channelKey, programs);
            totalSaved += programs.length;
            channelsProcessed++;
        }
    }

    console.log(`[Catchup] EPG snapshot cycle complete - ${channelsProcessed} channels, ${totalSaved} program entries processed.`);
}

module.exports = {
    extractM3uCatchupInfo,
    extractXtreamCatchupInfo,
    buildCatchupUrl,
    getCatchupStreams,
    snapshotAllEpgToHistory
};