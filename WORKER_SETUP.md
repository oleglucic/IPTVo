# Cloudflare Worker Setup Guide

## Prerequisites

1. **Cloudflare account** — Sign up at <https://cloudflare.com> (free tier is sufficient)
2. **Node.js 18+** installed locally
3. **Wrangler CLI** — Cloudflare's deployment tool

## Step 1: Install Wrangler & Login

```bash
npm install -g wrangler
wrangler login
```

This opens a browser to authorize Wrangler with your Cloudflare account.

## Step 2: Create KV Namespace (for dead URL tracking)

```bash
# Create production KV namespace
wrangler kv:namespace create "LOGO_KV"

# Create preview KV namespace (for wrangler dev)
wrangler kv:namespace create "LOGO_KV" --preview
```

**Output example:**

```text
🌀 Creating namespace with title "iptvo-logo-proxy-LOGO_KV"
✅ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "LOGO_KV"
id = "abc123def456..."
preview_id = "xyz789..."
```

## Step 3: Update `wrangler.toml` with KV IDs

Edit `wrangler.toml` and replace the placeholder IDs:

```toml
[[kv_namespaces]]
binding = "LOGO_KV"
id = "abc123def456..."           # <- your production KV ID
preview_id = "xyz789..."         # <- your preview KV ID
```

## Step 4: Deploy the Worker

```bash
wrangler deploy
```

**Expected output:**

```text
✅ Successfully deployed to https://iptvo-logo-proxy.<your-account>.workers.dev
```

**Note your Worker URL** — it will be something like:

```text
https://iptvo-logo-proxy.oleglucic.workers.dev
```

## Step 5: Configure the Backend

Set the `LOGO_PROXY_URL` environment variable in your backend deployment:

```bash
# For Docker
docker run -e LOGO_PROXY_URL=https://iptvo-logo-proxy.oleglucic.workers.dev/logo ...

# For Railway/Render/Fly.io
# Add LOGO_PROXY_URL=https://iptvo-logo-proxy.oleglucic.workers.dev/logo in env vars

# For local development (.env)
LOGO_PROXY_URL=https://iptvo-logo-proxy.oleglucic.workers.dev/logo
```

The URL **must end with `/logo`** — the full endpoint is:

```text
https://your-worker.workers.dev/logo?url=<base64url>&fallback=<base64url>&name=ChannelName
```

## Step 6: Verify Deployment

Test the worker directly:

```bash
# Test with a known logo URL
curl "https://iptvo-logo-proxy.oleglucic.workers.dev/logo?url=$(node -e "console.log(Buffer.from('https://i.imgur.com/P9Tqkg1.png').toString('base64').replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,''))")"
```

Should return an image (or SVG placeholder if the logo fails).

Check health endpoint:

```bash
curl https://iptvo-logo-proxy.oleglucic.workers.dev/health
# {"status":"ok","timestamp":1234567890}
```

## Free Tier Limits

| Resource | Limit |
| ---------- | ------- |
| Requests/day | 100,000 |
| CPU time/request | 10ms (50ms with unbound) |
| KV reads/day | 100,000 |
| KV writes/day | 1,000 |
| Cache storage | Unlimited (edge) |

**Estimated usage:** ~2,000-5,000 requests/day for typical IPTV catalog — well within limits.

## Development Mode

```bash
# Local development with live reload
wrangler dev

# Test locally at http://localhost:8787
```

## Troubleshooting

| Issue | Solution |
| ------- | ---------- |
| `KV namespace not found` | Run `wrangler kv:namespace create` again, update `wrangler.toml` |
| `Worker not found` | Check `wrangler.toml` name matches deployed name |
| CORS errors | Worker returns `Access-Control-Allow-Origin: *` — should work |
| Images not loading | Check `X-Logo-Source` header in response (placeholder/primary/fallback) |

## Worker Logs

```bash
# View live logs
wrangler tail

# Filter by source
wrangler tail --format json | jq 'select(.request.url | contains("imgur"))'
```

## Custom Domain (Optional)

```bash
# Add custom domain
wrangler custom-domain add logo-proxy.iptv.cam
```

---

## Edge Asset Worker (`iptvo-assets`)

A second worker serves posters, logos, and cached catalog/manifest JSON at
`assets.oleglucic.com` (see `iptvo-assets.worker.js`). It is separate from the
`nuvio-iptv` logo proxy and uses its own KV namespace (`iptvo-assets-kv`,
binding `ASSETS_KV`) to stamp a catalog generation for edge-cache invalidation.

Its Wrangler config lives in **`wrangler.iptvo-assets.toml`** (the root
`wrangler.toml` targets `nuvio-iptv`, so it cannot deploy this worker).

### Deploy manually

```bash
wrangler deploy -c wrangler.iptvo-assets.toml
```

### Connect to Workers Builds (auto-deploy on push)

1. In the Cloudflare dashboard, go to **Workers & Pages** and select the
   `iptvo-assets` worker.
2. Select **Settings → Builds → Connect**, choose **GitHub**, and pick the
   `IPTVo` repository. The Cloudflare GitHub App must already be installed
   (it is, from the `nuvio-iptv` connection).
3. Build settings:
   - **Deploy command**: `npx wrangler deploy -c wrangler.iptvo-assets.toml`
   - **Production branch**: `main`
4. The worker **name in the dashboard must match** `wrangler.iptvo-assets.toml`
   (`iptvo-assets`) or the build fails (Workers name requirement).
5. Push a commit to `main` → Workers Builds runs the deploy command.

The `nuvio-iptv` worker is already connected this way (201 auto-builds on
every branch push, surfaced as the "Workers Builds: nuvio-iptv" check).
