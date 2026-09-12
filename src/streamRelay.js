// streamRelay.js
// Manages one ffmpeg child process per active session.
// One HLS subfolder per session under repo-root cache/hls/.
// Uses child_process.spawn, fs, path.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./logger').for('streamRelay');

// --- HDR detection ---
/**
 * Probes a stream URL to determine if it carries HDR video (PQ/HLG transfer
 * characteristics). Times out and returns false (assume SDR) rather than
 * hanging — an HDR-detection failure should never block a stream from
 * starting, it should just fall back to treating it as SDR.
 * @param {string} upstreamUrl
 * @returns {Promise<boolean>}
 */
async function detectHdr(upstreamUrl) {
    try {
        const result = await execFile(
            'ffprobe',
            [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=color_transfer',
                '-of', 'json',
                upstreamUrl,
            ],
            { timeout: 5000 }
        );
        const data = JSON.parse(result.stdout);
        if (data.streams && data.streams[0] && data.streams[0].color_transfer) {
            const transfer = data.streams[0].color_transfer;
            return transfer === 'smpte2084' || transfer === 'arib-std-b67';
        }
        return false;
    } catch (e) {
        // timeout, ffprobe non-zero exit, JSON parse failure, etc.
        console.warn(`[HDR Detect] ${e.message || 'unknown error'}`);
        return false;
    }
}
// --- Working directory for HLS output ---
// One subfolder per session, created the first time it's needed.
// Mirrors the existing poster cache directory pattern in imageEngine.js.
const SESSION_HLS_DIR = path.join(__dirname, '..', 'cache', 'hls');

// In-memory map: sessionId -> { process: <ChildProcess>, upstreamUrl: <string>, rendition: <string> }
const activeProcesses = new Map();

// Global cap: only counts REAL encodes (rendition !== 'source'), never remux/passthrough
let activeTranscodeJobCount = 0;

// Note: sessionId is validated as UUID v4 format in server.js routes before
// reaching this function (defense-in-depth checks at lines 1976-1978 and 2069-2071),
// making the path safe for directory creation.
function ensureSessionDir(sessionId) {
    // semgrep-ignore path-join-resolve-traversal - sessionId validated as UUID in server.js routes
    const dir = path.join(SESSION_HLS_DIR, sessionId);
    // semgrep-ignore path-join-resolve-traversal - sessionId validated as UUID in server.js routes
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// --- startRealStream ---

/**
 * Spawns ffmpeg to remux or transcode an upstream URL into HLS.
 * Idempotent: does nothing if activeProcesses already has this sessionId.
 * @param {string} sessionId
 * @param {string} upstreamUrl
 * @param {string|number} rendition - either the literal string 'source' (passthrough/remux)
 *   or a number matching one of TRANSCODE_RENDITIONS (e.g. 720). When 'source', audio is
 *   copied and video is not re-encoded. When a number, video is transcoded to that height.
 * @param {number} [maxConcurrentJobs] - optional global cap for real encodes.
 *   When not provided, no cap is applied (backs-compat with Phase 1 flow).
 */
/**
 * Spawns ffmpeg to remux or transcode an upstream URL into HLS.
 * Idempotent: does nothing if activeProcesses already has this sessionId.
 * @param {string} sessionId
 * @param {string} upstreamUrl
 * @param {string|number} rendition - either the literal string 'source' (passthrough/remux)
 *   or a number matching one of TRANSCODE_RENDITIONS (e.g. 720). When 'source', audio is
 *   copied and video is not re-encoded. When a number, video is transcoded to that height.
 * @param {number} [maxConcurrentJobs] - optional global cap for real encodes.
 *   When not provided, no cap is applied (backs-compat with Phase 1 flow).
 * @returns {Promise<{error?: string}>} Returns { error: 'capacity' } if the transcoding
 *   job cap is hit, otherwise undefined.
 */
async function startRealStream(sessionId, upstreamUrl, rendition, maxConcurrentJobs) {
    if (activeProcesses.has(sessionId)) {
        // Already running — idempotent, do nothing
        return;
    }

    const sessionDir = ensureSessionDir(sessionId);

    // When a numeric rendition is requested, do transcoding logic.
    // When 'source', use the original passthrough/remux behavior.
    if (rendition !== 'source') {
        // Import transcode config here to avoid top-level I/O in the module
        const { buildVideoEncodeArgs } = require('./transcodeConfig');

        // Detect HDR on the upstream source
        const sourceIsHdr = await detectHdr(upstreamUrl);

        // Enforce global concurrency cap for real encodes
        if (maxConcurrentJobs !== undefined && activeTranscodeJobCount >= maxConcurrentJobs) {
            return { error: 'capacity' };
        }

        // Build video encode arguments from the transcoder config
        const videoArgs = buildVideoEncodeArgs({
            targetHeight: rendition,
            codec: process.env.TRANSCODE_CODEC,
            hwaccel: process.env.TRANSCODE_HWACCEL,
            crf: process.env.TRANSCODE_CRF,
            preset: process.env.TRANSCODE_PRESET,
            sourceIsHdr,
        });

        // Increment the global counter before spawning
        activeTranscodeJobCount++;

        // Capture rendition for use in cleanup handlers
        const jobRendition = rendition;

        const ffmpeg = spawn(
            'ffmpeg',
            [
                '-i', upstreamUrl,
                ...videoArgs,
                '-c:a', 'copy',
                '-f', 'hls',
                '-hls_time', '4',
                '-hls_list_size', '6',
                '-hls_flags', 'delete_segments+append_list',
                '-hls_segment_filename', path.join(sessionDir, 'seg_%05d.ts'),
                path.join(sessionDir, 'playlist.m3u8'),
            ],
            {
                // Don't kill ffmpeg on SIGHUP, let it manage its own lifecycle
                detached: false,
            }
        );

        let stderrBuffer = '';
        ffmpeg.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
            // Log periodically to avoid flooding, or on exit
        });

        ffmpeg.on('close', (code) => {
            log.info(`[Relay ${sessionId}] ffmpeg closed with code ${code}`);
            activeProcesses.delete(sessionId);
            // Decrement the global counter when the job finishes (only for real encodes)
            if (jobRendition !== 'source') {
                activeTranscodeJobCount--;
            }
        });

        ffmpeg.on('error', (err) => {
            log.error(`[Relay ${sessionId}] ffmpeg spawn error:`, err.message);
            activeProcesses.delete(sessionId);
            // Also decrement on error if this was a real encode job
            if (jobRendition !== 'source') {
                activeTranscodeJobCount--;
            }
        });

        // Store in active map — include rendition info for concurrency bookkeeping
        activeProcesses.set(sessionId, {
            process: ffmpeg,
            upstreamUrl,
            rendition: jobRendition,
        });

        log.info(`[Relay ${sessionId}] Started transcoded stream ${jobRendition}p from ${upstreamUrl}`);
    } else {
        // Original passthrough/remux branch (rendition === 'source')
        const ffmpeg = spawn(
            'ffmpeg',
            [
                '-i', upstreamUrl,
                '-c', 'copy',
                '-f', 'hls',
                '-hls_time', '4',
                '-hls_list_size', '6',
                '-hls_flags', 'delete_segments+append_list',
                '-hls_segment_filename', path.join(sessionDir, 'seg_%05d.ts'),
                path.join(sessionDir, 'playlist.m3u8'),
            ],
            {
                // Don't kill ffmpeg on SIGHUP, let it manage its own lifecycle
                detached: false,
            }
        );

        let stderrBuffer = '';
        ffmpeg.stderr.on('data', (data) => {
            stderrBuffer += data.toString();
            // Log periodically to avoid flooding, or on exit
        });

        ffmpeg.on('close', (code) => {
            log.info(`[Relay ${sessionId}] ffmpeg closed with code ${code}`);
            activeProcesses.delete(sessionId);
            // Source streams don't count toward transcode cap
        });

        ffmpeg.on('error', (err) => {
            log.error(`[Relay ${sessionId}] ffmpeg spawn error:`, err.message);
            activeProcesses.delete(sessionId);
        });

        // Store in active map
        activeProcesses.set(sessionId, {
            process: ffmpeg,
            upstreamUrl,
        });

        log.info(`[Relay ${sessionId}] Started real stream from ${upstreamUrl}`);
    }
}
// --- startCountdownStream ---

/**
 * Spawns ffmpeg to generate a black screen with countdown text.
 * @param {string} sessionId
 * @param {number} countdownSeconds - duration of the countdown in seconds
 */
function startCountdownStream(sessionId, countdownSeconds) {
    const sessionDir = ensureSessionDir(sessionId);

    const ffmpeg = spawn(
        'ffmpeg',
        [
            '-f', 'lavfi',
            '-i', 'color=c=black:s=1280x720:r=25',
            `-vf`, `drawtext=fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2:text='Concurrency limit reached — closing oldest stream in %{eif\\:${countdownSeconds}-t\\:d} s'`,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-t', countdownSeconds.toString(),
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '0',
            '-hls_flags', 'append_list',
            '-hls_segment_filename', path.join(sessionDir, 'seg_%05d.ts'),
            path.join(sessionDir, 'playlist.m3u8'),
        ],
        {
            detached: false,
        }
    );

    let stderrBuffer = '';
    ffmpeg.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
    });

    ffmpeg.on('close', (code) => {
        log.info(`[Relay ${sessionId}] countdown ffmpeg closed with code ${code}`);
        activeProcesses.delete(sessionId);
    });

    ffmpeg.on('error', (err) => {
        log.error(`[Relay ${sessionId}] countdown ffmpeg spawn error:`, err.message);
        activeProcesses.delete(sessionId);
    });

    activeProcesses.set(sessionId, {
        process: ffmpeg,
        upstreamUrl: null,
    });

    log.info(`[Relay ${sessionId}] Started countdown stream for ${countdownSeconds}s`);
}

// --- stopFfmpegForSession ---

/**
 * Sends SIGTERM to the ffmpeg process for a session, removes it from the map,
 * and deletes the session's working directory.
 * Idempotent: does nothing if activeProcesses does not have this sessionId.
 * @param {string} sessionId
 */
function stopFfmpegForSession(sessionId) {
    const entry = activeProcesses.get(sessionId);
    if (!entry) {
        // Not running — idempotent, never throw
        return;
    }

    try {
        const proc = entry.process;
        if (proc && !proc.killed) {
            proc.kill('SIGTERM');
        }
    } catch (e) {
        log.error(`[stopFfmpegForSession ${sessionId}] error killing process:`, e.message);
    }

    activeProcesses.delete(sessionId);

    // Decrement the global transcode job counter only if this was a real encode
    // (not a 'source' remux/passthrough session)
    if (entry.rendition !== 'source') {
        activeTranscodeJobCount--;
    }

    // Delete the session's working directory
    // semgrep-ignore path-join-resolve-traversal - sessionId validated as UUID in server.js routes
    const sessionDir = path.join(SESSION_HLS_DIR, sessionId);
    try {
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    } catch (e) {
        log.error(`[stopFfmpegForSession ${sessionId}] error removing dir:`, e.message);
    }

    log.info(`[stopFfmpegForSession ${sessionId}] stopped and cleaned up`);
}

// --- getSessionDir ---

/**
 * Returns the HLS working directory path for a session.
 * Used by HTTP route handlers to serve files.
 * @param {string} sessionId
 * @returns {string}
 */
function getSessionDir(sessionId) {
    // semgrep-ignore path-join-resolve-traversal - sessionId validated as UUID in server.js routes
    return path.join(SESSION_HLS_DIR, sessionId);
}

module.exports = {
    startRealStream,
    startCountdownStream,
    stopFfmpegForSession,
    getSessionDir,
};