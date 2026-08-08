# IPTVo — Stremio/Nuvio IPTV Addon

A self-hosted Stremio/Nuvio addon serving live IPTV channels from M3U or Xtream Codes providers. Built with Node.js/Express, featuring intelligent channel deduplication, iptv-org reference data integration, AI-powered curation, Cloudflare Worker logo proxy, and automatic poster generation.

## Features

- **Multi-format support** — M3U playlists and Xtream Codes API
- **Intelligent channel deduplication** — Canonical channel IDs via iptv-org reference data (87k+ channels, 39k+ logos, 250 countries)
- **AI curation fallback** — OpenRouter-powered deduplication for channels not in iptv-org (requires user-provided API key)
- **Authoritative metadata** — Canonical names, logos, and country scopes from iptv-org (always used when matched)
- **Cloudflare Worker logo proxy** — Edge caching, rate limit handling (429 backoff), 403/404 fallback chain, dead URL tracking (KV 24h TTL)
- **Redis logo cache** — 7-day TTL logo buffers survive restarts (~2GB for 40k logos)
- **Automatic poster generation** — Sharp-powered composites with blur/halo backgrounds, cached to disk
- **Catch-up TV support** — Extracts catch-up metadata from M3U/Xtream, surfaces as stream badges
- **EPG integration** — XMLTV parsing with streaming SAX parser for memory efficiency
- **Redis caching** — Playlist parse cache with 1hr TTL, proactive refresh every 15min
- **Postgres persistence** — AI override mappings, EPG history, logo URL tracking (auto-initialized on startup)
- **Docker-ready** — Multi-stage build, Portainer deployment

## Quick Start

### Prerequisites

- Node.js 20+ (for local development)
- Docker & Docker Compose (for production via Portainer)
- Postgres database (for AI override persistence, EPG history, logo URL tracking)
- Redis instance (for cache persistence, logo buffers)
- OpenRouter API key (required if AI Curation enabled in config)
- Cloudflare account (for Worker logo proxy — free tier sufficient)

### Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
export REDIS_URL="redis://localhost:6379"

# Start server
node server.js
```

### Production (Portainer)

**Option 1: Use pre-built image (recommended)**
1. In Portainer, create a stack with:
```yaml
version: '3.8'
services:
  iptvo:
    image: itsoleglucic/iptvo:latest
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://user:pass@host:5432/dbname
      - REDIS_URL=redis://host:6379
      - LOGO_PROXY_URL=https://your-worker.workers.dev/logo  # Cloudflare Worker URL
    restart: unless-stopped
```
2. Deploy

**Option 2: Build from source**
1. Push to your repository
2. In Portainer, create a stack from `docker-compose.yml`
3. Configure environment variables:
   - `DATABASE_URL` — Postgres connection string
   - `REDIS_URL` — Redis connection string
   - `LOGO_PROXY_URL` — Cloudflare Worker logo proxy URL (e.g., `https://assets.yourdomain.com/logo`)
4. Deploy — Portainer handles the build and restart

## Cloudflare Worker Logo Proxy (Required for Production)

The logo proxy eliminates rate limits, handles 403/404 fallbacks, and caches at Cloudflare's edge (30 days).

### One-time Setup

```bash
# Install Wrangler CLI
npm install -g wrangler
wrangler login

# Create KV namespace for dead URL tracking
wrangler kv:namespace create "LOGO_KV"
wrangler kv:namespace create "LOGO_KV" --preview
```

Update `wrangler.toml` with the returned KV IDs, then deploy:

```bash
wrangler deploy
```

Worker URL: `https://logo-proxy.<account>.workers.dev/logo`

Set `LOGO_PROXY_URL=https://logo-proxy.<account>.workers.dev/logo` in backend env vars.

### Worker Behavior

- **Fallback chain per channel**: iptv-org authoritative logo → playlist `tvg-logo`/`stream_icon` → generated SVG
- **Rate limits**: Automatic 429 retry with exponential backoff
- **Dead URLs**: Tracked in KV (24h TTL) to avoid retry storms
- **Caching**: Cloudflare CDN caches successful responses 30 days
- **CORS**: `Access-Control-Allow-Origin: *` for Stremio compatibility

## Configuration

The addon accepts configuration via Stremio's configuration UI or direct URL parameters. The configuration is a base64-encoded JSON object:

```json
{
  "type": "m3u" | "xtream",
  "m3uUrl": "https://provider.com/playlist.m3u",
  "xtreamUrl": "https://provider.com",
  "username": "user",
  "password": "pass",
  "epg": "https://provider.com/epg.xml.gz",
  "include": ["Group A", "Group B"],       // optional: only include these groups
  "exclude": ["Group C"],                  // optional: exclude these groups
  "timezoneOffset": 0,                     // EPG timezone offset in hours
  "fallbackPreference": "custom",          // poster style
  "iptvOrg": true,                         // enable iptv-org matching (default: true)
  "ai": true,                              // enable AI curation (default: true)
  "openrouterKey": "sk-or-v1-..."          // REQUIRED if ai: true
}
```

**Important**: `openrouterKey` is **mandatory** if `ai: true` (server env var deprecated). Enter it in the dashboard UI.

In Stremio, paste the base64-encoded config into the addon configuration field. The dashboard at `/` provides a UI to generate this.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /:config/manifest.json` | Stremio manifest |
| `GET /:config/catalog/:type/:id.json` | Catalog (with optional genre/search) |
| `GET /:config/meta/:type/:id.json` | Meta information for a channel |
| `GET /:config/stream/:type/:id.json` | Stream URLs for a channel |
| `GET /:config/poster/:id.png` | Generated poster image |
| `POST /api/get-groups` | Discover groups from M3U/Xtream (dashboard helper) |
| `GET /health` | Health check |

## Architecture: Channel ID Pipeline

For each raw channel from the provider:

```
1. Extract country prefix from group-title (regex + exclusions blocklist)
2. Clean channel name (strip hd/4k/vip/raw/hevc/1080p/etc — NOT "premium")
3. Extract +N timeshift suffix -> _plusN
4. Apply synonyms (jr -> junior)
5. Build base cId: ${countryScopeKey}_${baseCleanName}${timeshiftSuffix}

6. CHECK iptv-org reference data (authoritative):
   - lookupChannel(cleanName, countryScopeKey) -> exact match
   - lookupChannelFuzzy(cleanName, countryScopeKey) -> fuzzy match (Fuse.js, threshold 0.2)
   - If found: use iptv-org's officialId, canonical name, logo, country scope
   - SKIP AI entirely for matched channels (iptv-org name/logo ALWAYS used)

7. CHECK Postgres ai_overrides (confidence >= 0.5):
   - Use stored canonical_id

8. QUEUE for async AI curation (OpenRouter):
   - Batched (100 channels/batch)
   - AI only normalizes the NAME, code reconstructs ${scope}_${cleanedName}
   - Results persisted to Postgres with 0.85 confidence
   - On AI cleanup: retries iptv-org match to promote to authoritative ID
```

## Logo Pipeline

```
getPremiumPoster(cId, logoUrl, fallbackUrl, channelName)
  │
  ├─▶ 1. In-memory cache (30 min) — fastest
  │
  ├─▶ 2. Redis logo cache (7 days) — survives restarts
  │
  ├─▶ 3. Cloudflare Worker proxy — handles rate limits, fallbacks, edge cache
  │     ├─▶ Try iptv-org authoritative logo
  │     ├─▶ Try playlist fallback logo
  │     └─▶ Return SVG placeholder
  │
  └─▶ 4. Generate SVG fallback (no external calls)
```

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express routes, cache orchestration, proactive refresh |
| `iptvParser.js` | Core M3U/Xtream parsing, channel ID pipeline |
| `iptvOrgRef.js` | iptv-org data fetch + exact/fuzzy lookup |
| `aiCurator.js` | AI deduplication queue, OpenRouter integration |
| `imageEngine.js` | Poster generation (Sharp), logo cache, Worker proxy |
| `db.js` | Postgres pool, override CRUD, EPG history, logo URL tracking |
| `dbInit.js` | Auto-initialize database schema on startup |
| `redisCache.js` | Playlist cache read/write, logo buffer persist |
| `catchup.js` | Catch-up metadata extraction |
| `universalEpg.js` | XMLTV EPG parsing (SAX streaming) |
| `logo-proxy.worker.js` | Cloudflare Worker logo proxy |
| `wrangler.toml` | Worker config |

## Docker

Pre-built image available on Docker Hub:
```bash
docker pull itsoleglucic/iptvo:latest
```

To run:
```bash
docker run -d \
  --name iptvo \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/dbname" \
  -e REDIS_URL="redis://host:6379" \
  -e LOGO_PROXY_URL="https://your-worker.workers.dev/logo" \
  itsoleglucic/iptvo:latest
```

### Building from source

```dockerfile
# Multi-stage build
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig fonts-inter fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

Font packages are required for Sharp text rendering (poster initials badge).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `DATABASE_URL` | Yes | Postgres connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `LOGO_PROXY_URL` | Yes* | Cloudflare Worker logo proxy URL (required for production) |
| `OPENROUTER_API_KEY` | No** | Deprecated — use per-config `openrouterKey` instead |

*Required for production to avoid rate limits. Optional for local dev (falls back to direct fetch).
**Server env var is deprecated. Provide OpenRouter key in dashboard config per-addon instance.

## Database Schema (Auto-initialized)

Tables are created automatically on first startup:

```sql
-- AI override mappings
CREATE TABLE ai_overrides (
  raw_name TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- EPG history for catch-up
CREATE TABLE epg_history (
  channel_key TEXT NOT NULL,
  title TEXT,
  description TEXT,
  start_time BIGINT NOT NULL,
  stop_time BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_key, start_time)
);

-- Persistent logo URL tracking (survives restarts, no expiry)
CREATE TABLE logo_urls (
  channel_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  source TEXT DEFAULT 'unknown',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Development Notes

- **No local Docker** — All Docker-dependent testing happens via git push + Portainer rebuild
- **Test before push** — Use `node -e` standalone scripts with real decoded production config against `streamFetchIPTV` directly
- **Two-pass M3U parsing** — Any variable computed on the `#EXTINF:` pass must be added to both the `cItem` construction AND the destructuring on the URL-line pass
- **XTream parsing is single-pass** — No scope issues there

## License

MIT