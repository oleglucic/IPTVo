// streamRelay.js
// Manages one ffmpeg child process per active session.
// One HLS subfolder per session under repo-root cache/hls/.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./logger').for('streamRelay');
const { hasRedis, redisClient } = require('./redisCache');
const redis = hasRedis ? redisClient : null;

const TRANSCODE_JOBS_KEY = 'transcode:activeJobs';

async function reserveTranscodeSlot(maxJobs) {
    if (maxJobs === undefined || maxJobs === null) return true;
    const limit = Number(maxJobs);
    if (!Number.isFinite(limit) || limit <= 0) return true;

    if (!redis) {
        if (activeTranscodeJobCount >= limit) return false;
        activeTranscodeJobCount++;
        return true;
    }
    try {
        const ok = await redis.eval(
            `local c = tonumber(redis.call('GET', KEYS[1]) or '0')
            if c >= tonumber(ARGV[1]) then return 0 end
            redis.call('INCR', KEYS[1])
            return 1`,
            1,
            TRANSCODE_JOBS_KEY,
            limit
        );
        return ok === 1;
    } catch (e) {
        log.error('reserveTranscodeSlot:', e.message);
        return false;
    }
}

async function releaseTranscodeSlot() {
    if (!redis) {
        activeTranscodeJobCount = Math.max(0, activeTranscodeJobCount - 1);
        return;
    }
    try {
        await redis.eval(
            `local c = tonumber(redis.call('GET', KEYS[1]) or '0')
            if c <= 0 then redis.call('SET', KEYS[1], '0') return 0 end
            return redis.call('DECR', KEYS[1])`,
            1,
            TRANSCODE_JOBS_KEY
        );
    } catch (e) {
        log.error('releaseTranscodeSlot:', e.message);
    }
}

/**
 * @returns {Promise<string|null>} smpte2084 | arib-std-b67 | null
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
        const transfer = data.streams && data.streams[0] && data.streams[0].color_transfer;
        if (transfer === 'smpte2084' || transfer === 'arib-std-b67') {
            return transfer;
        }
        return null;
    } catch (e) {
        console.warn(`[HDR Detect] ${e.message || 'unknown error'}`);
        return null;
    }
}

const SESSION_HLS_DIR = path.join(__dirname, '..', 'cache', 'hls');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeSessionPath(sessionId, ...parts) {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
    const base = path.resolve(SESSION_HLS_DIR);
    const resolved = path.resolve(base, sessionId, ...parts);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
}

const activeProcesses = new Map();
let activeTranscodeJobCount = 0;

function attachStderrDrain(ffmpeg, sessionId, label) {
    let tail = '';
    const MAX = 4096;
    ffmpeg.stderr.on('data', (data) => {
        const chunk = data.toString();
        tail = (tail + chunk).slice(-MAX);
    });
    ffmpeg.on('close', (code) => {
        if (code && code !== 0 && tail) {
            log.warn(`[Relay ${sessionId}] ${label} stderr tail: ${tail.slice(-500)}`);
        }
    });
}

function ensureSessionDir(sessionId) {
    if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        throw new Error('Invalid sessionId');
    }
    const safeId = path.basename(sessionId);
    if (safeId !== sessionId || !UUID_RE.test(safeId)) {
        throw new Error('Invalid sessionId');
    }
    const base = path.resolve(SESSION_HLS_DIR);
    const dir = path.resolve(base, safeId);
    if (!dir.startsWith(base + path.sep)) {
        throw new Error('Invalid sessionId');
    }
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

async function startRealStream(sessionId, upstreamUrl, rendition, maxConcurrentJobs) {
    if (activeProcesses.has(sessionId)) {
        return;
    }

    if (rendition === undefined || rendition === null || rendition === '') {
        rendition = 'source';
    }

    const sessionDir = ensureSessionDir(sessionId);

    if (activeProcesses.has(sessionId)) {
        return;
    }
    activeProcesses.set(sessionId, { process: null, upstreamUrl, pending: true });

    if (rendition !== 'source') {
        const { buildVideoEncodeArgs } = require('./transcodeConfig');

        const hdrTransfer = await detectHdr(upstreamUrl);

        const maxJobs = maxConcurrentJobs !== undefined
            ? maxConcurrentJobs
            : parseInt(process.env.TRANSCODE_MAX_CONCURRENT_JOBS || '2', 10);
        const reserved = await reserveTranscodeSlot(maxJobs);
        if (!reserved) {
            activeProcesses.delete(sessionId);
            return { error: 'capacity' };
        }

        const videoArgs = buildVideoEncodeArgs({
            targetHeight: rendition,
            codec: process.env.TRANSCODE_CODEC,
            hwaccel: process.env.TRANSCODE_HWACCEL,
            crf: process.env.TRANSCODE_CRF,
            preset: process.env.TRANSCODE_PRESET,
            sourceIsHdr: hdrTransfer,
            vaapiDevice: process.env.TRANSCODE_VAAPI_DEVICE,
        });

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
            { detached: false }
        );

        attachStderrDrain(ffmpeg, sessionId, 'transcode');

        ffmpeg.on('close', (code) => {
            log.info(`[Relay ${sessionId}] ffmpeg closed with code ${code}`);
            const prev = activeProcesses.get(sessionId);
            activeProcesses.delete(sessionId);
            if (prev && prev.countsTowardsTranscodeCap) {
                prev.countsTowardsTranscodeCap = false;
                releaseTranscodeSlot().catch(() => {});
            }
        });

        ffmpeg.on('error', (err) => {
            log.error(`[Relay ${sessionId}] ffmpeg spawn error:`, err.message);
            const prev = activeProcesses.get(sessionId);
            activeProcesses.delete(sessionId);
            if (prev && prev.countsTowardsTranscodeCap) {
                prev.countsTowardsTranscodeCap = false;
                releaseTranscodeSlot().catch(() => {});
            }
        });

        activeProcesses.set(sessionId, {
            process: ffmpeg,
            upstreamUrl,
            rendition: jobRendition,
            countsTowardsTranscodeCap: true,
        });

        log.info(`[Relay ${sessionId}] Started transcoded stream ${jobRendition}p`);
    } else {
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
            { detached: false }
        );

        attachStderrDrain(ffmpeg, sessionId, 'remux');

        ffmpeg.on('close', (code) => {
            log.info(`[Relay ${sessionId}] ffmpeg closed with code ${code}`);
            activeProcesses.delete(sessionId);
        });

        ffmpeg.on('error', (err) => {
            log.error(`[Relay ${sessionId}] ffmpeg spawn error:`, err.message);
            activeProcesses.delete(sessionId);
        });

        activeProcesses.set(sessionId, {
            process: ffmpeg,
            upstreamUrl,
            countsTowardsTranscodeCap: false,
        });

        log.info(`[Relay ${sessionId}] Started real stream (source)`);
    }
}

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
        { detached: false }
    );

    attachStderrDrain(ffmpeg, sessionId, 'countdown');

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
        countsTowardsTranscodeCap: false,
    });

    log.info(`[Relay ${sessionId}] Started countdown stream for ${countdownSeconds}s`);
}

function stopFfmpegForSession(sessionId) {
    const entry = activeProcesses.get(sessionId);
    if (!entry) {
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

    if (entry.countsTowardsTranscodeCap) {
        entry.countsTowardsTranscodeCap = false;
        releaseTranscodeSlot().catch(() => {});
    }

    const sessionDir = safeSessionPath(sessionId);
    try {
        if (sessionDir && fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    } catch (e) {
        log.error(`[stopFfmpegForSession ${sessionId}] error removing dir:`, e.message);
    }

    log.info(`[stopFfmpegForSession ${sessionId}] stopped and cleaned up`);
}

function getSessionDir(sessionId) {
    return safeSessionPath(sessionId);
}

module.exports = {
    startRealStream,
    startCountdownStream,
    stopFfmpegForSession,
    getSessionDir,
    safeSessionPath,
};
