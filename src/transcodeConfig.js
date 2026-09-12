/**
 * Decides the ffmpeg video-encoding arguments for one rendition.
 * @param {Object} opts
 * @param {number} opts.targetHeight - e.g. 720
 * @param {string} opts.codec - 'h264' | 'hevc' | 'av1'
 * @param {string} opts.hwaccel - 'none' | 'nvenc' | 'qsv' | 'vaapi'
 * @param {number} opts.crf
 * @param {string} opts.preset
 * @param {boolean|string|null} opts.sourceIsHdr - true/false, or transfer characteristic
 *   ('smpte2084' | 'arib-std-b67') from ffprobe; null/false = SDR
 * @param {string} [opts.vaapiDevice] - e.g. /dev/dri/renderD128 (VAAPI only)
 * @returns {string[]} ffmpeg CLI arguments for the VIDEO portion only
 */
function buildVideoEncodeArgs({
    targetHeight,
    codec,
    hwaccel,
    crf,
    preset,
    sourceIsHdr,
    vaapiDevice,
}) {
    const args = [];
    const transfer = normalizeTransfer(sourceIsHdr);
    const isHdr = transfer !== null;
    const device = vaapiDevice || process.env.TRANSCODE_VAAPI_DEVICE || '/dev/dri/renderD128';

    if (hwaccel === 'vaapi') {
        args.push('-vaapi_device', device);
        if (isHdr && codec === 'h264') {
            args.push('-vf');
            args.push(
                `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,` +
                `zscale=t=bt709:m=bt709:r=tv,format=nv12,scale=-2:${targetHeight},format=nv12,hwupload`
            );
        } else {
            args.push('-vf');
            args.push(`format=nv12,scale=-2:${targetHeight},format=nv12,hwupload`);
        }
    } else if (isHdr && codec === 'h264') {
        args.push('-vf');
        args.push(
            `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,` +
            `zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=-2:${targetHeight}`
        );
    } else {
        args.push('-vf');
        args.push(`scale=-2:${targetHeight}`);
    }

    if ((codec === 'hevc' || codec === 'av1') && isHdr) {
        args.push('-color_primaries', 'bt2020');
        args.push('-color_trc', transfer);
        args.push('-colorspace', 'bt2020nc');
    }

    let encoder = getEncoder(codec, hwaccel);
    let rateControl;

    if (encoder === 'libsvtav1') {
        preset = mapSvtAv1Preset(preset);
    }

    if (hwaccel === 'none' || encoder === 'libsvtav1') {
        rateControl = ['-c:v', encoder, '-preset', String(preset), '-crf', String(crf)];
    } else if (hwaccel === 'nvenc') {
        const nvencPreset = preset === 'veryfast' ? 'p1' : String(preset);
        rateControl = ['-c:v', encoder, '-preset', nvencPreset, '-cq', String(crf)];
    } else if (hwaccel === 'vaapi') {
        rateControl = ['-c:v', encoder, '-global_quality', String(crf)];
    } else {
        rateControl = ['-c:v', encoder, '-preset', String(preset), '-global_quality', String(crf)];
    }

    args.push(...rateControl);
    return args;
}

function normalizeTransfer(sourceIsHdr) {
    if (sourceIsHdr === true) return 'smpte2084';
    if (sourceIsHdr === false || sourceIsHdr == null || sourceIsHdr === '') return null;
    const t = String(sourceIsHdr).toLowerCase();
    if (t === 'smpte2084' || t === 'arib-std-b67') return t;
    if (t === 'pq') return 'smpte2084';
    if (t === 'hlg') return 'arib-std-b67';
    return null;
}

function mapSvtAv1Preset(preset) {
    if (preset === undefined || preset === null || preset === '') return '10';
    const p = String(preset).toLowerCase();
    if (/^\d+$/.test(p)) {
        const n = Math.max(0, Math.min(13, parseInt(p, 10)));
        return String(n);
    }
    const map = {
        ultrafast: '12',
        superfast: '11',
        veryfast: '10',
        faster: '9',
        fast: '8',
        medium: '6',
        slow: '4',
        slower: '3',
        veryslow: '2',
        placebo: '1',
    };
    return map[p] || '10';
}

function getEncoder(codec, hwaccel) {
    const encoders = {
        h264: {
            none: 'libx264',
            nvenc: 'h264_nvenc',
            qsv: 'h264_qsv',
            vaapi: 'h264_vaapi',
        },
        hevc: {
            none: 'libx265',
            nvenc: 'hevc_nvenc',
            qsv: 'hevc_qsv',
            vaapi: 'hevc_vaapi',
        },
        av1: {
            none: 'libsvtav1',
            nvenc: 'av1_nvenc',
            qsv: 'av1_qsv',
            vaapi: 'libsvtav1',
        },
    };

    return encoders[codec]?.[hwaccel] || 'libx264';
}

module.exports = {
    buildVideoEncodeArgs,
    normalizeTransfer,
    mapSvtAv1Preset,
    getEncoder,
};
