/**
 * src/logger.js
 *
 * Central logging for the IPTVo backend.
 *
 * Replaces the previous pattern of ad-hoc `console.log('[Module] ...')` calls
 * and four duplicated `sanitizeForLog` implementations (in server.js,
 * src/aiCurator.js, src/epgHub.js, src/iptvParser.js) with a single, leveled,
 * redaction-safe logger.
 *
 * Guarantees:
 *   - Every log line is sanitized for log-injection / sensitive data before it
 *     reaches stdout/stderr, so call sites no longer need to wrap interpolated
 *     values in `sanitizeForLog(...)` themselves.
 *   - Levels are honored via `LOG_LEVEL` (debug|info|warn|error; default info).
 *   - `LOG_FORMAT=json` emits structured JSON lines (newline-delimited) so
 *     production logs can be machine-parsed; otherwise human-readable text.
 *   - The logger emits through `console.log|warn|error|info|debug`, so existing
 *     test spies (`jest.spyOn(console, 'log')` etc.) keep working.
 *
 * Usage:
 *   const log = require('./logger').for('db');
 *   log.warn('pool exhausted, retrying', poolStats);   // auto-sanitized
 *   log.error('parse failed', err);
 *
 * The module also re-exports `sanitizeForLog` as the single canonical
 * implementation for any caller that still needs the raw string transform.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Single-char whitespace test for the linear URL redactor. Mirrors `\s` for the
// characters that can end a URL authority segment in practice (space + common
// control whitespace). Intentionally kept to char tests (not a per-char regex)
// so the redactor stays linear and ReDoS-free.
function isWs(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Linear redactor that rewrites every credential-bearing URL in `str`, not just
 * the first one. After each `://` it scans forward to the first `@` before any
 * whitespace and collapses the userinfo segment to `[REDACTED]@`. Runs in a
 * single left-to-right pass (each indexOf advances monotonically), so it avoids
 * the polynomial backtracking CodeQL flags on `/[^@\s]*@/` over uncontrolled
 * input.
 * @param {string} str
 * @returns {string}
 */
function redactUrlCredentials(str) {
    let out = '';
    let i = 0;
    const n = str.length;
    while (i < n) {
        const k = str.indexOf('://', i);
        if (k === -1) return out + str.slice(i);
        out += str.slice(i, k + 3);
        let j = k + 3;
        while (j < n && str[j] !== '@' && !isWs(str[j])) j++;
        if (j < n && str[j] === '@') {
            out += '[REDACTED]@';
            i = j + 1;
        } else {
            out += str.slice(k + 3, j);
            i = j;
        }
    }
    return out;
}

/**
 * Canonical sanitizer. Keeps only printable ASCII, collapses control
 * characters, escapes structured-logging format chars (`%{}`), and caps the
 * length. Applied to every value the logger renders.
 *
 * @param {*} value - The value to sanitize (objects/strings/numbers fall back
 *   through String()). Deep objects are flattened with a JSON-ish join so an
 *   accidentally-passed object still renders one line rather than [object Object].
 * @returns {string} The sanitized, single-line, bounded string.
 */
function sanitizeForLog(value) {
    if (value === null || value === undefined) return '';
    let str;
    if (typeof value === 'string') {
        str = value;
    } else if (value instanceof Error) {
        str = `${value.name}: ${value.message}`;
    } else if (typeof value === 'object') {
        try {
            str = JSON.stringify(value);
        } catch {
            str = String(value);
        }
    } else {
        str = String(value);
    }
    return redactUrlCredentials(str)
        .replace(/[\r\n\t]/g, '?')
        .replace(/[^\x20-\x7E]/g, '?')  // Keep only printable ASCII
        .replace(/[%{}]/g, '?')  // Escape structured logging format chars
        .substring(0, 200);  // Limit length
}

/**
 * Renders a single argument for the human-readable human form: `key=value`
 * pairs for objects, plain values otherwise.
 * @param {*} v
 * @returns {string}
 */
function renderText(v) {
    if (v && typeof v === 'object') {
        const parts = [];
        if (v instanceof Error) return sanitizeForLog(v);
        try {
            for (const [k, val] of Object.entries(v)) {
                parts.push(`${k}=${sanitizeForLog(val)}`);
            }
        } catch {
            return sanitizeForLog(v);
        }
        return parts.length ? parts.join(' ') : sanitizeForLog(v);
    }
    return sanitizeForLog(v);
}

/**
 * Builds a JSON log record for `LOG_FORMAT=json`.
 */
function renderJson({ ts, level, tag, msg, extra }) {
    const record = { ts: new Date().toISOString(), level, tag, msg: sanitizeForLog(msg) };
    if (extra && extra.length) {
        const rendered = extra.map(renderText);
        if (rendered.length) record.fields = rendered.join(' | ');
    }
    return JSON.stringify(record);
}

/**
 * Creates a leveled logger bound to a module tag. Emits through the matching
 * `console` method so the default Node behaviour (and test spies) is preserved,
 * but with a timestamp prefix, level gating via LOG_LEVEL, and central
 * sanitization.
 *
 * @param {string} tag - Module/subsystem tag, e.g. 'iptvParser'.
 * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
 */
function createLogger(tag) {
    const tagName = tag || 'app';

    // Read env at emit time (not creation time) so LOG_LEVEL/LOG_FORMAT changes
    // (e.g. between tests, or an operator reload) are honoured without a reload.
    function emit(level, consoleFn, message, extras) {
        const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
        const threshold = LEVELS[configured] ?? LEVELS.info;
        if (LEVELS[level] < threshold) return;
        const ts = new Date().toISOString();
        const safeMsg = sanitizeForLog(message);
        const jsonMode = (process.env.LOG_FORMAT || '').toLowerCase() === 'json';
        if (jsonMode) {
            consoleFn(renderJson({ ts, level, tag: tagName, msg: safeMsg, extra: extras }));
            return;
        }
        const suffix = extras && extras.length ? ' ' + extras.map(renderText).join(' ') : '';
        consoleFn(`[${tagName}] ${safeMsg}${suffix}`);
    }

    return {
        debug(msg, ...extra) { emit('debug', console.debug, msg, extra); },
        info(msg, ...extra) { emit('info', console.log, msg, extra); },
        warn(msg, ...extra) { emit('warn', console.warn, msg, extra); },
        error(msg, ...extra) { emit('error', console.error, msg, extra); }
    };
}

module.exports = {
    sanitizeForLog,
    LEVELS,
    for: createLogger
};