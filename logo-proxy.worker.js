/**
 * Cloudflare Worker: Logo Proxy with Fallback Chain
 *
 * Deploy: Cloudflare Dashboard (Workers & Pages) or wrangler deploy
 * Endpoint: GET /logo?url=<base64url_encoded_original>[&fallback=<base64url_encoded_fallback>]
 *
 * Fallback chain:
 * 1. Primary URL (iptv-org authoritative or playlist tvg-logo)
 * 2. Fallback URL (playlist logo if primary was iptv-org, or vice versa)
 * 3. Generated SVG placeholder
 *
 * Caching: Cloudflare CDN caches successful responses for 30 days (Cache-Control)
 * Dead URLs: Stored in KV with 24h TTL to avoid retry storms
 */

// ============ CONFIG ============
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEAD_URL_TTL_SECONDS = 24 * 60 * 60;    // 24 hours
const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;

// Known problematic domains that need special handling (reserved for future use)

// SVG placeholder generator
function generatePlaceholderSvg(text = 'Live TV') {
    return `<svg width="600" height="900" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#0f172a" />
                <stop offset="100%" stop-color="#1e293b" />
            </linearGradient>
        </defs>
        <rect width="600" height="900" fill="url(#bgGrad)" />
        <text x="300" y="450" text-anchor="middle" dominant-baseline="middle"
              font-family="system-ui, -apple-system, sans-serif" font-size="42" font-weight="600" fill="#94a3b8">
            ${escapeHtml(text)}
        </text>
    </svg>`;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&apos;');
}

function isValidHttpUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

// Base64URL encode/decode (no padding, URL-safe)
function base64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(str)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function base64urlDecode(str) {
    try {
        // Add padding back
        const pad = str.length % 4;
        const padded = pad ? str + '='.repeat(4 - pad) : str;
        // Restore standard base64
        const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
        return decodeURIComponent(escape(atob(base64)));
    } catch {
        return null;
    }
}

// Check if URL is marked dead in KV
async function isDeadUrlKV(env, url) {
    const key = `dead:${base64urlEncode(url)}`;
    const val = await env.LOGO_KV.get(key);
    return val === '1';
}

// Mark URL as dead in KV
async function markDeadUrlKV(env, url) {
    const key = `dead:${base64urlEncode(url)}`;
    await env.LOGO_KV.put(key, '1', { expirationTtl: DEAD_URL_TTL_SECONDS });
}

// Fetch with retry logic
async function fetchWithRetry(url, attempt = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; IPTVo-LogoBot/1.0; +https://iptv.cam)',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': 'https://iptv.cam/',
            },
            signal: controller.signal,
            redirect: 'follow',
        });

        clearTimeout(timeoutId);

        // Success
        if (response.status === 200) {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.startsWith('image/')) {
                const buffer = await response.arrayBuffer();
                return { status: 'success', buffer, contentType };
            }
            return { status: 'error', error: `Non-image content-type: ${contentType}` };
        }

        // Rate limited - retry with backoff
        if (response.status === 429 && attempt < MAX_RETRIES) {
            const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            return fetchWithRetry(url, attempt + 1);
        }

        // 403/404 - don't retry, try fallback
        if (response.status === 403 || response.status === 404) {
            return { status: 'dead', statusCode: response.status };
        }

        // Other errors - retry on 5xx
        if (response.status >= 500 && attempt < MAX_RETRIES) {
            const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            return fetchWithRetry(url, attempt + 1);
        }

        return { status: 'error', error: `HTTP ${response.status}` };
    } catch (err) {
        clearTimeout(timeoutId);

        // Network errors - retry
        if (attempt < MAX_RETRIES && (
            err.name === 'AbortError' ||
            err.name === 'TimeoutError' ||
            err.message.includes('network') ||
            err.message.includes('fetch')
        )) {
            const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
            return fetchWithRetry(url, attempt + 1);
        }

        return { status: 'error', error: err.message };
    }
}

// Try fetching a single URL, checking dead KV first
async function tryFetchUrl(env, url) {
    if (!url || !isValidHttpUrl(url)) {
        return { status: 'error', error: 'Invalid URL' };
    }

    // Check dead KV first
    if (await isDeadUrlKV(env, url)) {
        return { status: 'dead', reason: 'kv-marked' };
    }

    const result = await fetchWithRetry(url);

    if (result.status === 'dead') {
        await markDeadUrlKV(env, url);
    }

    return result;
}

// Main handler
export default {
    async fetch(request, env, _ctx) {
        const url = new URL(request.url);

        // Health check
        if (url.pathname === '/health') {
            return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Only handle /logo endpoint
        if (url.pathname !== '/logo') {
            return new Response('Not Found', { status: 404 });
        }

        // Parse parameters
        const primaryB64 = url.searchParams.get('url');
        const fallbackB64 = url.searchParams.get('fallback');
        const channelName = url.searchParams.get('name') || 'Live TV';

        if (!primaryB64) {
            return new Response('Missing url parameter', { status: 400 });
        }

        const primaryUrl = base64urlDecode(primaryB64);
        const fallbackUrl = fallbackB64 ? base64urlDecode(fallbackB64) : null;

        if (!primaryUrl || !isValidHttpUrl(primaryUrl)) {
            return new Response('Invalid primary URL', { status: 400 });
        }

        const startTime = Date.now();

        // Determine source for logging
        let source = 'primary';

        // Try primary URL
        let result = await tryFetchUrl(env, primaryUrl);

        if (result.status === 'success') {
            source = 'primary';
        } else if (fallbackUrl) {
            // Try fallback URL
            source = 'fallback';
            result = await tryFetchUrl(env, fallbackUrl);
        }

        // Build response
        let responseBody;
        let contentType;
        let statusCode = 200;
        let cacheTtl = CACHE_TTL_SECONDS;

        if (result.status === 'success') {
            responseBody = result.buffer;
            contentType = result.contentType;
        } else {
            // Generate placeholder SVG
            source = 'placeholder';
            responseBody = generatePlaceholderSvg(channelName);
            contentType = 'image/svg+xml';
            // Shorter cache for placeholders (1 day)
            cacheTtl = 24 * 60 * 60;
            statusCode = 200; // Still return 200 with placeholder
        }

        const headers = new Headers({
            'Content-Type': contentType,
            'Cache-Control': `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}, stale-while-revalidate=86400`,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET',
            'X-Logo-Source': source,
            'X-Response-Time': `${Date.now() - startTime}ms`,
        });

        // Add CORS preflight handling
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers });
        }

        return new Response(responseBody, { status: statusCode, headers });
    }
};// force rebuild Sat Aug  8 01:26:51 CEST 2026
