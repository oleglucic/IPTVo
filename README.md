# IPTVo — Stremio/Nuvio IPTV Addon

A self-hosted Stremio/Nuvio addon serving live IPTV channels from M3U or Xtream Codes providers. Built with Node.js/Express, featuring intelligent channel deduplication, iptv-org reference data integration, AI-powered curation, and automatic poster generation.

## Features

- **Multi-format support** — M3U playlists and Xtream Codes API
- **Intelligent channel deduplication** — Canonical channel IDs via iptv-org reference data (47k+ channels, 39k+ logos, 250 countries)
- **AI curation fallback** — OpenRouter-powered deduplication for channels not in iptv-org
- **Authoritative metadata** — Canonical names, logos, and country scopes from iptv-org
- **Automatic poster generation** — Sharp-powered composites with blur/halo backgrounds, cached to disk
- **Catch-up TV support** — Extracts catch-up metadata from M3U/Xtream, surfaces as stream badges
- **EPG integration** — XMLTV parsing with streaming SAX parser for memory efficiency
- **Redis caching** — Playlist parse cache with 1hr TTL, proactive refresh every 15min
- **Postgres persistence** — AI override mappings stored in `ai_overrides` table
- **Docker-ready** — Multi-stage build, Portainer deployment

## Quick Start

### Prerequisites

- Node.js 20+ (for local development)
- Docker & Docker Compose (for production via Portainer)
- Postgres database (for AI override persistence)
- Redis instance (for cache persistence)
- OpenRouter API key (optional, for AI curation)

### Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
export REDIS_URL="redis://localhost:6379"
export OPENROUTER_API_KEY="your-openrouter-key"  # optional

# Start server
node server.js
```

### Production (Portainer)

1. Push to your repository
2. In Portainer, create a stack from `docker-compose.yml`
3. Configure environment variables:
   - `DATABASE_URL` — Postgres connection string
   - `REDIS_URL` — Redis connection string
   - `OPENROUTER_API_KEY` — (optional) OpenRouter API key for AI curation
4. Deploy — Portainer handles the build and restart

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
  "fallbackPreference": "custom"           // reserved for future use
}
```

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
   - SKIP AI entirely for matched channels

7. CHECK Postgres ai_overrides (confidence >= 0.5):
   - Use stored canonical_id

8. QUEUE for async AI curation (OpenRouter):
   - Batched (100 channels/batch)
   - AI only normalizes the NAME, code reconstructs ${scope}_${cleanedName}
   - Results persisted to Postgres with 0.85 confidence
```

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express routes, cache orchestration, proactive refresh |
| `iptvParser.js` | Core M3U/Xtream parsing, channel ID pipeline |
| `iptvOrgRef.js` | iptv-org data fetch + exact/fuzzy lookup |
| `aiCurator.js` | AI deduplication queue, OpenRouter integration |
| `imageEngine.js` | Poster generation (Sharp), dead-URL cache, rate limiting |
| `db.js` | Postgres pool, override CRUD |
| `redisCache.js` | Playlist cache read/write |
| `catchup.js` | Catch-up metadata extraction |
| `universalEpg.js` | XMLTV EPG parsing (SAX streaming) |

## Docker

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
| `OPENROUTER_API_KEY` | No | OpenRouter API key for AI curation |

## Database Schema

```sql
CREATE TABLE ai_overrides (
  raw_name TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
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