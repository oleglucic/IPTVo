/**
 * iptvo-assets.worker.js — serves ALL IPTVo assets off Cloudflare's edge under
 * assets.oleglucic.com (a NEW worker; the live `nuvio-iptv` logo proxy is not
 * touched until this is validated). Routes:
 *   /logo?url=..&fallback=..    — logo proxy (base64, KV dead-URL, retries, svg placeholder)
 *   /poster/<cId>.png           — proxy Node poster, edge-cache 30d
 *   /<userId>/catalog|meta|manifest.json — proxy + edge-cache JSON (5min/1d)
 *   /health                     — liveness
 *
 * Edge caching uses Cloudflare's free Cache API (caches.default) + Workers KV for
 * a generation stamp so a re-parse invalidates cached pages. SSRF-safe: only
 * forwards to the configured origins (the logo URLs decoded from /logo params are
 * validated HTTP(S); the addon origin is fixed).
 */
const ADDON_ORIGIN = 'https://iptvo.oleglucic.com';   // Node server (behind CF tunnel)
const KV_GEN_KEY = 'assets:generation';
const POSTER_TTL = 30 * 24 * 60 * 60;   // 30d
const CATALOG_TTL = 5 * 60;             // 5min
const MANIFEST_TTL = 24 * 60 * 60;      // 1d

// ---- logo proxy helpers (mirror logo-proxy.worker.js) ----------------------
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEAD_URL_TTL_SECONDS = 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
function b64u(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); }
function b64ud(str) { try { const p = str.length % 4; const pad = p ? str + "=".repeat(4 - p) : str; return decodeURIComponent(escape(atob(pad.replace(/-/g, "+").replace(/_/g, "/")))); } catch { return null; } }
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function placeholderSvg(text = "Live TV") {
  return `<svg width="640" height="640" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e293b"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><text x="320" y="320" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="40" font-weight="600" fill="#94a3b8">${escapeHtml(text)}</text></svg>`;
}
// SSRF guard: only http/https to PUBLIC hosts. Blocks loopback, private,
// link-local, and cloud-metadata ranges so a caller can't make the worker fetch
// internal/credential endpoints (e.g. 169.254.169.254). Mirrors iptvParser's
// isSafeUrl.
const BLOCKED_HOSTS = ["localhost", "metadata.google.internal", "metadata", ".internal", ".local"];
function isPrivateHost(hostname) {
  let h = (hostname || "").toLowerCase();
  if (BLOCKED_HOSTS.some((b) => b === h || h.endsWith(b))) return true;
  h = h.replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  // v4-mapped v6 normalizes to hex (::ffff:7f00:1) — decode the embedded IPv4
  // (big-endian 32-bit) and fall through to the private-range checks so
  // ::ffff:127.0.0.1 (metadata SSRF) cannot bypass them.
  if (h.startsWith("::ffff:")) {
    // hostname groups are 16-bit, possibly compressed (::ffff:7f00:1) — zero-pad
    // each group so the big-endian decode lands on the correct octets.
    const n = parseInt(h.slice(7).split(":").map(s => s.padStart(4, "0")).join("").padStart(8, "0"), 16);
    h = String((n >> 24) & 255) + "." + ((n >> 16) & 255) + "." + ((n >> 8) & 255) + "." + (n & 255);
  }
  if (/^(127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^0\.0\.0\.0$/.test(h)) return true;
  if (/^(::1|fe80:|fc|fd)/.test(h)) return true;
  return false;
}
function isValidHttp(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return false;
    return !isPrivateHost(p.hostname);
  } catch { return false; }
}
async function fetchWithRetry(url, attempt = 0) {
  const ctl = new AbortController(); const tid = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; IPTVo-Assets/1.0)", "Accept": "image/*,*/*;q=0.8" }, signal: ctl.signal, redirect: "manual" });
    clearTimeout(tid);
    // Reject a redirect whose target resolves to a blocked/private host (a logo
    // URL that bounces to an internal endpoint must not be followed).
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (loc && !isValidHttp(new URL(loc, url).toString())) return { status: "error", error: "unsafe redirect" };
    }
    if (r.status === 200) { const ct = r.headers.get("content-type") || ""; if (ct.startsWith("image/")) { const b = await r.arrayBuffer(); return { status: "success", buffer: b, ct }; } return { status: "error", error: "non-image" }; }
    if ((r.status === 403 || r.status === 404)) return { status: "dead", code: r.status };
    if ((r.status === 429 || r.status >= 500) && attempt < MAX_RETRIES) { await new Promise(x => setTimeout(x, 500 * Math.pow(2, attempt))); return fetchWithRetry(url, attempt + 1); }
    return { status: "error", error: "HTTP " + r.status };
  } catch (e) { clearTimeout(tid); if (attempt < MAX_RETRIES && (e.name === "AbortError" || /network|fetch/i.test(e.message))) { await new Promise(x => setTimeout(x, 500 * Math.pow(2, attempt))); return fetchWithRetry(url, attempt + 1); } return { status: "error", error: e.message }; }
}

// ---- main fetch handler ----------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Served under assets.oleglucic.com/iptvo/* — strip the prefix so the routing
    // below (health/poster/logo/json) sees the addon-relative path, then proxied
    // to the origin using the stripped path.
    if (url.pathname === "/iptvo" || url.pathname.startsWith("/iptvo/")) {
      url.pathname = url.pathname.slice("/iptvo".length) || "/";
    }
    if (url.pathname === "/health") return new Response("ok");

    // POSTER: /poster/<cId>.png — edge-cache from Node origin
    if (url.pathname.startsWith("/poster/")) {
      const cache = caches.default;
      const key = url.pathname + url.search; // includes ?t= cache-buster
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await fetch(ADDON_ORIGIN + url.pathname + url.search, { redirect: "follow" });
      if (res.ok) {
        const h = new Headers(res.headers);
        h.set("Cache-Control", `public, max-age=${POSTER_TTL}, s-maxage=${POSTER_TTL}, stale-while-revalidate=86400`);
        const body = await res.arrayBuffer();
        const cpy = new Response(body, { status: res.status, headers: h });
        ctx.waitUntil(cache.put(key, cpy.clone()));
        return cpy;
      }
      return res;
    }

    // LOGO: /logo?url=... — existing proxy logic
    if (url.pathname === "/logo") {
      const primaryB64 = url.searchParams.get("url");
      if (!primaryB64) return new Response("Missing url", { status: 400 });
      const primaryUrl = b64ud(primaryB64);
      if (!primaryUrl || !isValidHttp(primaryUrl)) return new Response("Invalid url", { status: 400 });
      const fallbackB64 = url.searchParams.get("fallback");
      const fallbackUrl = fallbackB64 ? b64ud(fallbackB64) : null;
      const name = url.searchParams.get("name") || "Live TV";
      let result = await fetchWithRetry(primaryUrl);
      if (result.status !== "success" && fallbackUrl && isValidHttp(fallbackUrl)) result = await fetchWithRetry(fallbackUrl);
      const headers = new Headers({ "Access-Control-Allow-Origin": "*" });
      if (result.status === "success") {
        headers.set("Content-Type", result.ct); headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`); headers.set("X-Logo-Source", "proxy");
        return new Response(result.buffer, { status: 200, headers });
      }
      const svg = placeholderSvg(name);
      return new Response(svg, { status: 200, headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*", "X-Logo-Source": "placeholder" } });
    }

    // JSON addon routes (catalog/meta/manifest): edge-cache
    if (request.method === "GET" && !url.pathname.startsWith("/api/") && /\.json$/.test(url.pathname)) {
      const cache = caches.default;
      const gen = parseInt((await env.ASSETS_KV.get(KV_GEN_KEY)) || "0", 10);
      const key = `${url.pathname}?${url.search}#${gen}`;
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = await fetch(ADDON_ORIGIN + url.pathname + url.search, { headers: { Accept: "application/json" }, redirect: "follow" });
      if (res.ok) {
        const body = await res.clone().text();
        if (body && body.length > 20 && body !== "[]") {
          const ttl = url.pathname.endsWith("manifest.json") ? MANIFEST_TTL : CATALOG_TTL;
          const h = new Headers(res.headers); h.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=3600`); h.set("CF-Addon-Cache", "hit");
          const cpy = new Response(body, { status: res.status, headers: h });
          ctx.waitUntil(cache.put(key, cpy.clone()));
          return cpy;
        }
      }
      return res;
    }

    // everything else → pass through to Node origin
    return fetch(ADDON_ORIGIN + url.pathname + url.search, { redirect: "follow" });
  },

  // purge: bump the generation via KV so cached pages invalidate on re-parse.
  async request(request, env) {
    if (new URL(request.url).pathname === "/_purge") {
      const cur = parseInt((await env.ASSETS_KV.get(KV_GEN_KEY)) || "0", 10);
      await env.ASSETS_KV.put(KV_GEN_KEY, String(cur + 1));
      return new Response("purged");
    }
    return this.fetch(request, env, null);
  }
};
