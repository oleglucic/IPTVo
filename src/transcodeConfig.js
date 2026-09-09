/**
 * Decides the ffmpeg video-encoding arguments for one rendition.
 * @param {Object} opts
 * @param {number} opts.targetHeight - e.g. 720
 * @param {string} opts.codec - 'h264' | 'hevc' | 'av1'
 * @param {string} opts.hwaccel - 'none' | 'nvenc' | 'qsv' | 'vaapi'
 * @param {number} opts.crf
 * @param {string} opts.preset
 * @param {boolean} opts.sourceIsHdr - result of ffprobe HDR detection (Step 4)
 * @returns {string[]} ffmpeg CLI arguments for the VIDEO portion only (not
 *   input/output/audio/HLS muxing args — those are added by streamRelay.js)
 */
function buildVideoEncodeArgs({ targetHeight, codec, hwaccel, crf, preset, sourceIsHdr }) {
    const args = [];

    // 1. Scale filter
    if (sourceIsHdr === true && codec === 'h264') {
        // HDR tone-map-down chain for putting HDR source into H.264 output
        // (which cannot carry HDR metadata)
        args.push('-vf');
        args.push(`zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,scale=-2:${targetHeight}`);
    } else {
        args.push('-vf');
        args.push(`scale=-2:${targetHeight}`);
    }

    // 2. HDR metadata preservation for hevc/av1
    if ((codec === 'hevc' || codec === 'av1') && sourceIsHdr === true) {
        args.push('-color_primaries');
        args.push('bt2020');
        args.push('-color_trc');
        args.push('smpte2084');
        args.push('-colorspace');
        args.push('bt2020nc');
    }

    // 3. Choose encoder and rate-control flags based on hwaccel
    let encoder, rateControl;

    if (hwaccel === 'none') {
        // Software encoding: use -crf
        encoder = getEncoder(codec, hwaccel);
        rateControl = ['-c:v', encoder, '-preset', preset, '-crf', String(crf)];
    } else {
        // Hardware encoding
        if (hwaccel === 'nvenc') {
            // nvenc uses -cq and p1-p7 preset names
            encoder = getEncoder(codec, hwaccel);
            const nvencPreset = preset === 'veryfast' ? 'p1' : preset;
            rateControl = ['-c:v', encoder, '-preset', nvencPreset, '-cq', String(crf)];
        } else {
            // qsv or vaapi: use -global_quality
            encoder = getEncoder(codec, hwaccel);
            rateControl = ['-c:v', encoder, '-preset', preset, '-global_quality', String(crf)];
        }
    }

    args.push(...rateControl);

    return args;
}

/**
 * Returns the ffmpeg encoder name for a given codec/hwaccel combination.
 * For vaapi+av1, returns 'libsvtav1' (the fallback — caller may log a warning).
 * @param {string} codec - 'h264' | 'hevc' | 'av1'
 * @param {string} hwaccel - 'none' | 'nvenc' | 'qsv' | 'vaapi'
 * @returns {string} encoder name
 */
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
            vaapi: 'libsvtav1', // fallback for vaapi+av1
        },
    };

    return encoders[codec]?.[hwaccel] || `libx264`;
}

module.exports = {
    buildVideoEncodeArgs,
};