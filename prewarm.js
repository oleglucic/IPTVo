/**
 * Full iptv-org poster/logo prewarm (task #40).
 *
 * Iterates every iptv-org channel logo and renders its poster PNG to disk,
 * saving the logo URL into Postgres (logo_urls) and Redis (logo buffer) so the
 * DB is always ready for any channel without waiting for a user request.
 *
 * Design:
 *  - Change-driven + idempotent: skips channels whose poster already exists on
 *    disk at the deterministic cache path; only rendered once.
 *  - Concurrency-capped (PREWARM_CONCURRENCY, default 8) so the batch doesn't
 *    spike CPU on the deploy host.
 *  - Runs in the background; a health/guard prevents concurrent runs.
 *  - Posters persist to disk (cache/), logo buffers to Redis (7d), the URL map
 *    to Postgres (no expiry). Nothing depends on the in-memory hot tier.
 */
const fs = require('fs');
const path = require('path');
const iptvOrgRef = require('./iptvOrgRef');
const { getPremiumPoster } = require('./imageEngine');
const { setLogoUrl } = require('./db');

const cacheDir = path.join(__dirname, 'cache');
const CONCURRENCY = parseInt(process.env.PREWARM_CONCURRENCY || '8', 10);
const CHUNK_PROGRESS = Math.max(500, Math.floor(CONCURRENCY * 60));

let running = false;

/** Build the deterministic cache path for a channel poster, mirroring imageEngine. */
function posterPathFor(cId, logoUrl) {
    const urlHash = logoUrl
        ? require('crypto').createHash('md5').update(logoUrl).digest('hex').substring(0, 8)
        : 'none';
    return path.join(cacheDir, `${cId}_${urlHash}_sq640.png`);
}

/**
 * Ensures a channel logo is registered and available in the poster cache.
 * @param {string} officialId - The IPTV-org channel identifier.
 * @param {string} logoUrl - The channel logo URL.
 * @returns {'rendered'|'cached'|'skipped'|string} The processing status, including an error message when rendering fails.
 */
async function warmOne(officialId, logoUrl) {
    if (!logoUrl || typeof logoUrl !== 'string' || !logoUrl.startsWith('http')) {
        // No logo: still register the channel id so the map is complete.
        await setLogoUrl(officialId, '', 'iptv-org').catch(() => {});
        return 'skipped';
    }
    // Scope defaults to global; the cId only needs to be unique + safe.
    const cId = `prewarm_${officialId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const cachePath = posterPathFor(cId, logoUrl);

    if (fs.existsSync(cachePath)) {
        // Already rendered; still refresh the URL map in case it changed.
        await setLogoUrl(officialId, logoUrl, 'iptv-org').catch(() => {});
        return 'cached';
    }

    try {
        await getPremiumPoster(cId, logoUrl, officialId);
        await setLogoUrl(officialId, logoUrl, 'iptv-org').catch(() => {});
        return 'rendered';
    } catch (e) {
        return `error-${e.message}`;
    }
}

/**
 * Prewarms the complete IPTV-org channel logo set.
 * @returns {Promise<Object>} A status summary indicating whether the run was already active, failed while awaiting refreshed data, or completed with rendered, cached, skipped, and error counts.
 */
async function prewarm() {
    if (running) return { status: 'already-running' };
    running = true;
    try {
        // Wait for the iptv-org reference data to be populated first.
        const t0 = Date.now();
        while (!iptvOrgRef.lastRefreshed && Date.now() - t0 < 10 * 60 * 1000) {
            await new Promise(r => setTimeout(r, 1000));
        }
        if (!iptvOrgRef.lastRefreshed) {
            return { status: 'error', reason: 'iptv-org never refreshed' };
        }

        const logos = iptvOrgRef.getChannelLogos() || new Map();
        const entries = [...logos.entries()];
        const counts = { rendered: 0, cached: 0, skipped: 0, error: 0 };
        const errors = [];
        let i = 0;

        const workers = Array.from({ length: CONCURRENCY }, async () => {
            while (i < entries.length) {
                const idx = i++;
                const [officialId, logoUrl] = entries[idx];
                const result = await warmOne(officialId, logoUrl);
                if (result === 'rendered') counts.rendered++;
                else if (result === 'cached') counts.cached++;
                else if (result === 'skipped') counts.skipped++;
                else { counts.error++; errors.push(`${officialId}: ${result}`); }
                if (idx % CHUNK_PROGRESS === 0) {
                    console.log(`[Prewarm] ${idx}/${entries.length} rendered=${counts.rendered} cached=${counts.cached} errors=${counts.error}`);
                }
            }
        });

        await Promise.all(workers);
        console.log(`[Prewarm] done: ${counts.rendered} rendered, ${counts.cached} cached, ${counts.skipped} no-logo, ${counts.error} errors in ${Date.now() - t0}ms`);
        if (errors.length) {
            console.log(`[Prewarm] first errors: ${errors.slice(0, 5).map(e => e.substring(0, 120)).join(' | ')}`);
        }
        return { status: 'done', ...counts };
    } finally {
        running = false;
    }
}

module.exports = { prewarm };