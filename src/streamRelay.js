// streamRelay.js
// Manages one ffmpeg child process per active session.
// One HLS subfolder per session under repo-root cache/hls/.
// Uses child_process.spawn, fs, path.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./logger').for('streamRelay');

// --- Working directory for HLS output ---
// One subfolder per session, created the first time it's needed.
// Mirrors the existing poster cache directory pattern in imageEngine.js.
const SESSION_HLS_DIR = path.join(__dirname, '..', 'cache', 'hls');

// In-memory map: sessionId -> { process: <ChildProcess>, upstreamUrl: <string> }
const activeProcesses = new Map();

function ensureSessionDir(sessionId) {
    const dir = path.join(SESSION_HLS_DIR, sessionId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// --- startRealStream ---

/**
 * Spawns ffmpeg to remux an upstream URL into HLS.
 * Idempotent: does nothing if activeProcesses already has this sessionId.
 * @param {string} sessionId
 * @param {string} upstreamUrl
 */
function startRealStream(sessionId, upstreamUrl) {
    if (activeProcesses.has(sessionId)) {
        // Already running — idempotent, do nothing
        return;
    }

    const sessionDir = ensureSessionDir(sessionId);

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
        // Optionally clean up the session directory after a delay
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

    // Delete the session's working directory
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
    return path.join(SESSION_HLS_DIR, sessionId);
}

module.exports = {
    startRealStream,
    startCountdownStream,
    stopFfmpegForSession,
    getSessionDir,
};