# Cloudflare Worker Setup Guide

IPTVo uses three Cloudflare Workers, all served under the coherent domain root
`assets.oleglucic.com/iptvo/*`. Each is auto-deployed from the repository via
**Workers Builds** (Connect-to-GitHub in the Cloudflare dashboard).

| Worker | Code | Config | Route | Purpose |
| ------ | ---- | ------ | ----- | ------- |
| `iptvo-root` | `logo-proxy.worker.js` | `wrangler.toml` | owns `assets.oleglucic.com` | domain anchor; `/logo` at root |
| `iptvo-fetch` | `logo-proxy.worker.js` | `wrangler.iptvo-fetch.toml` | `/iptvo/fetcher/*` | logo fetch via Cloudflare edge (rate-limit protection) |
| `iptvo-assets` | `iptvo-assets.worker.js` | `wrangler.iptvo-assets.toml` | `/iptvo/assets/*` | edge cache for posters + catalog/meta JSON |

## Prerequisites

1. **Cloudflare account** — Sign up at <https://cloudflare.com> (free tier is sufficient)
2. **Node.js 20+** installed locally
3. **Wrangler CLI** for manual deploys: `npm install -g wrangler && wrangler login`

## Set up: Connect to GitHub (recommended)

For each worker, open **Workers & Pages → [worker] → Settings → Builds & deployments → Connect to GitHub**:

1. Pick the `IPTVo` repository (the Cloudflare GitHub App must be installed).
2. Set the **Wrangler configuration file** per worker:
   - `iptvo-root` → `wrangler.toml`
   - `iptvo-fetch` → `wrangler.iptvo-fetch.toml`
   - `iptvo-assets` → `wrangler.iptvo-assets.toml`
3. Set the **Production branch** to `main`.
4. Enable **Caching** on `iptvo-fetch` and `iptvo-assets` (on by default).
5. Push a commit to `main` → each worker auto-deploys its own code.

The KV bindings (`LOGO_KV` for the logo workers, `ASSETS_KV` for `iptvo-assets`)
are declared in each wrangler config; create the namespaces once if deploying
manually.

## Manual deploy (alternative to Workers Builds)

```bash
npm install -g wrangler
wrangler login

# Create the KV namespace once, then paste its ID into the toml(s) that bind LOGO_KV
wrangler kv:namespace create "LOGO_KV"

# Deploy each worker
wrangler deploy                                    # iptvo-root (wrangler.toml)
wrangler deploy -c wrangler.iptvo-fetch.toml       # iptvo-fetch (logo fetcher)
wrangler deploy -c wrangler.iptvo-assets.toml      # iptvo-assets (edge cache)
```

## Configure the Backend

The **logo fetcher** URL (fetches logos through Cloudflare's edge to avoid
logo-host rate limits) goes into `LOGO_PROXY_URL`:

```bash
LOGO_PROXY_URL=https://assets.oleglucic.com/iptvo/fetcher/logo
```

Full endpoint:

```text
https://assets.oleglucic.com/iptvo/fetcher/logo?url=<base64url>&fallback=<base64url>&name=ChannelName
```

The **edge asset cache** (posters/catalog/meta) URL:

```bash
ASSET_BASE_URL=https://assets.oleglucic.com/iptvo/assets
```

The **edge purge** target (only if you enable the `/api/_edge-purge` endpoint):

```bash
ADDON_CACHE_URL=https://assets.oleglucic.com/iptvo/assets
EDGE_PURGE_SECRET=<your-secret>   # must match the worker's PURGE_TOKEN secret
```

## Verify

```bash
# Health
curl https://assets.oleglucic.com/iptvo/fetcher/health   # {"status":"ok",...}
curl https://assets.oleglucic.com/health                  # iptvo-root

# Logo fetch
curl "https://assets.oleglucic.com/iptvo/fetcher/logo?url=$(node -e "console.log(Buffer.from('https://i.imgur.com/P9Tqkg1.png').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''))")"
```

## Free Tier Limits

| Resource | Limit |
| ---------- | ------- |
| Requests/day | 100,000 |
| CPU time/request | 10ms (50ms with unbound) |
| KV reads/day | 100,000 |
| KV writes/day | 1,000 |
| Cache storage | Unlimited (edge) |

Estimated usage: ~2-5k requests/day for a typical IPTV catalog — well within limits.

## Development Mode

```bash
wrangler dev         # from wrangler.toml (iptvo-root)
wrangler dev -c wrangler.iptvo-fetch.toml
wrangler dev -c wrangler.iptvo-assets.toml
```

## Troubleshooting

| Issue | Solution |
| ------- | ------- |
| `KV namespace not found` | Create it, update the toml ID |
| `Worker not found` | Check the toml `name` matches the deployed worker |
| CORS errors | Worker returns `Access-Control-Allow-Origin: *` — should work |
| Images not loading | Check `X-Logo-Source` header (primary/fallback/placeholder) |

## Worker Logs

```bash
wrangler tail                       # live logs for the current config's worker
wrangler tail --format json | jq 'select(.request.url | contains("imgur"))'
```
