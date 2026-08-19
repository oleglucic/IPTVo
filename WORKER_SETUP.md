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
