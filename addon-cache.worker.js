/**
 * addon-cache.worker.js — edge caching for IPTVo (ISOLATED build/test; NOT the
 * live logo proxy). Sits in front of the addon origin and caches the heavy,
 * slow-changing JSON responses at the Cloudflare edge so the backend Node server
 * isn't hit for every catalog/meta view.
 *
 * What it caches (all free via Cloudflare Cache API + KV):
 *  - /:userId/manifest.json            — static addon manifest (cache long)
 *  - /:userId/catalog/tv/*.json        — 7k-channel catalog pages (biggest win)
 *  - /:userId/meta/tv/*.json           — per-channel meta
 * Posters (png) are already 30-day cached by the logo proxy / CDN.
 *
 * Design:
 *  - Cache-Control is set on origin responses by THIS worker (injected upstream),
 *    so Cloudflare's edge CDN holds them.
 *  - Purge: the backend can invalidate via a shared KV key holding a "generation"
 *    (bumped on re-parse). The worker keys cached entries by that generation, so a
 *    new parse automatically invalidates stale cached pages.
 *  - Never cache /api/* (auth/config live) or any response that is a placeholder.
 *
 * SSRF-safety: only forwards to the configured origin; no arbitrary fetch.
 */
const ORIGIN = 'https://iptvo.oleglucic.com'; // set at deploy; origin addon host
const MANIFEST_TTL = 24 * 60 * 60; // 1 day
const CATALOG_TTL = 5 * 60;        // 5 min (re-parse invalidation via generation)
const KV_GEN_KEY = 'addon-cache:generation';

/**
 * Determines whether an addon response is eligible for edge caching.
 * @param {Request} request - The incoming request to evaluate.
 * @param {Response} response - The response to evaluate.
 * @return {Promise<boolean>} `true` if the request and response meet caching requirements, `false` otherwise.
 */
async function shouldCache(request, response) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return false;         // never cache POST/etc (auth)
  if (url.pathname.startsWith('/api/')) return false; // never cache live API
  if (!response.ok) return false;
  const body = await response.clone().text();
  if (!body || body === '[]' || body.length < 20) return false;   // skip placeholders
  // Only JSON addon responses
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return false;
  return true;
}

/**
 * Determines the custom cache duration for an addon resource URL.
 * @param {URL} url - The resource URL to evaluate.
 * @return {number|null} The cache duration in seconds, or `null` when no custom policy applies.
 */
function cachePolicy(url) {
  if (url.pathname.endsWith('/manifest.json')) return MANIFEST_TTL;
  if (url.pathname.includes('/catalog/')) return CATALOG_TTL;
  if (url.pathname.includes('/meta/')) return CATALOG_TTL;
  return null; // unknown — do not add custom policy
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'content-type': 'application/json' } });
    }

    // Read current generation from KV (0 if unset) so cache keys change on re-parse.
    let gen = 0;
    try { gen = parseInt(await env.ADDON_CACHE_KV.get(KV_GEN_KEY) || '0', 10); } catch {}

    // ---- Serve from edge cache first ----
    // Cache API keys must be absolute request URLs; carry the generation as a
    // __gen query param so a re-parse (bumped generation) misses the cache.
    const cache = caches.default;
    const edgeUrl = new URL(url.toString());
    edgeUrl.searchParams.set('__gen', gen);
    const edgeKey = edgeUrl.toString();
    const cachedRes = await cache.match(edgeKey);
    if (cachedRes) {
      return new Response(cachedRes.body, { status: cachedRes.status, headers: cachedRes.headers, statusText: cachedRes.statusText });
    }

    // ---- Fetch from origin ----
    const upstream = await fetch(ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers: { 'Accept': 'application/json', 'User-Agent': request.headers.get('user-agent') || '' },
      redirect: 'follow',
    });
    const policy = cachePolicy(url);

    // Inject cache headers so Cloudflare's CDN also holds it at the URL level.
    if (policy && await shouldCache(request, upstream)) {
      const headers = new Headers(upstream.headers);
      headers.set('Cache-Control', `public, max-age=${policy}, s-maxage=${policy}, stale-while-revalidate=3600`);
      headers.set('CF-Addon-Cache', 'hit');
      const body = await upstream.arrayBuffer();
      // Store in edge cache (cache API) keyed with generation
      ctx.waitUntil(cache.put(edgeKey, new Response(body, { status: upstream.status, headers, statusText: upstream.statusText })));
      return new Response(body, { status: upstream.status, headers, statusText: upstream.statusText });
    }

    return upstream;
  },

  // Purge/invalidation is handled by the iptvo-assets worker's /_purge route;
  // this worker reads ADDON_CACHE_KV on each request so a bumped generation
  // automatically invalidates cached pages. No scheduled handler is needed.
};
