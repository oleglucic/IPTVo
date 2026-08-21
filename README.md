# IPTVo — Stremio/Nuvio IPTV Addon

A self-hosted Stremio/Nuvio addon serving live IPTV channels from M3U or Xtream Codes providers. Built with Node.js/Express, featuring intelligent channel deduplication, iptv-org reference data integration, AI-powered curation, Cloudflare Worker logo proxy, automatic poster generation, **user authentication with encrypted configs**, and **automated releases**.

## Features

- **Multi-format support** — M3U playlists and Xtream Codes API
- **User authentication system** — Register/login, session tokens, PBKDF2-SHA256 (100k iterations), AES-256-GCM encrypted configs with per-user salt/IV
- **Dual routing** — New user system (`/:userId/...`) and legacy base64 config (`/:config/...`)
- **Intelligent channel deduplication** — Canonical channel IDs via iptv-org reference data (47k+ channels, logos, 250+ countries)
- **Country code fallback** — Extracts country from group-title for improved iptv-org match rates
- **AI curation fallback** — OpenRouter-powered deduplication for unmatched channels (batched 100/batch, requires per-user API key)
- **Authoritative metadata** — Canonical names, logos, and country scopes from iptv-org (always used when matched)
- **Cloudflare Worker logo proxy** — Edge caching, rate limit handling (429 backoff), 403/404 fallback chain, dead URL tracking (KV 24h TTL)
- **SVG logo support** — Inline SVG placeholders served directly from Worker, cached at edge
- **Redis logo cache** — 7-day TTL logo buffers survive restarts (~2GB for 40k logos)
- **Automatic poster generation** — Sharp-powered composites with blur/halo backgrounds, cached to disk
- **Catch-up TV support** — Extracts catch-up metadata from M3U/Xtream, surfaces as stream badges
- **EPG integration** — XMLTV parsing with streaming SAX parser for memory efficiency
- **Redis caching** — Playlist parse cache with 1hr TTL, proactive refresh every 15min
- **Postgres persistence** — AI override mappings, EPG history, logo URL tracking, user accounts (auto-initialized on startup)
- **Apple HIG / Liquid Glass dashboard** — Guided 5-step setup (Provider → Groups → Matching & AI → Backup → Save & Install), mobile-first responsive
- **Docker-ready** — Multi-stage build, multi-arch (amd64/arm64), Portainer deployment
- **Automated releases** — Semantic versioning from commit messages, multi-arch Docker builds, Docker Hub + GHCR publishing, GitHub Releases

## Quick Start

### Prerequisites

- Node.js 20+ (for local development)
- Docker & Docker Compose (for production via Portainer)
- **Postgres database** (for AI override persistence, EPG history, logo URL tracking, user accounts)
- **Redis instance** (for cache persistence, logo buffers)
- OpenRouter API key (required if AI Curation enabled in config — **per-user, not server env**)
- Cloudflare account (for Worker logo proxy — free tier sufficient)
- `ENCRYPTION_KEY` — 32+ character secret for AES-GCM config encryption

### Self-Hosting PostgreSQL & Redis

You can run Postgres and Redis locally via Docker Compose, or use managed services.

#### Option A: All-in-One Docker Compose (recommended for self-hosting)

```yaml
# docker-compose.yml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: iptvo
      POSTGRES_USER: iptvo
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-changeme}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U iptvo -d iptvo"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 2gb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  iptvo:
    image: itsoleglucic/iptvo:latest
    ports:
      - "${PORT:-3000}:${PORT:-3000}"
    environment:
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - DATABASE_URL=postgresql://iptvo:${POSTGRES_PASSWORD:-changeme}@postgres:5432/iptvo
      - REDIS_URL=redis://redis:6379
      - LOGO_PROXY_URL=${LOGO_PROXY_URL:-https://assets.oleglucic.com/iptvo/fetcher/logo}
      - PORT=${PORT:-3000}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

**Usage:**

```bash
# Create .env file
cat > .env << 'EOF'
ENCRYPTION_KEY=your-32-char-secret-key-here
POSTGRES_PASSWORD=secure-password-here
LOGO_PROXY_URL=https://assets.oleglucic.com/iptvo/fetcher/logo
EOF

# Deploy
docker-compose up -d
```

#### Option B: Managed Services (Railway, Neon, Upstash, etc.)

| Service | Provider Examples | Connection String Format |
| --------- | ------------------ | ------------------------- |
| **PostgreSQL** | Neon, Supabase, Railway, Render, Aiven, Timescale | `postgresql://user:pass@host:5432/dbname?sslmode=require` |
| **Redis** | Upstash, Railway, Redis Cloud, Aiven, Render | `redis://default:pass@host:port` or `rediss://...` (TLS) |

**Example `.env` for managed services:**

```bash
ENCRYPTION_KEY=your-32-char-secret-key-here
DATABASE_URL=postgresql://user:pass@ep-xyz.us-east-1.neon.tech/iptvo?sslmode=require
REDIS_URL=redis://default:pass@fly-xyz.upstash.io:6379
LOGO_PROXY_URL=https://assets.oleglucic.com/iptvo/fetcher/logo
```

#### Option C: External Host + Portainer Stack

If running Postgres/Redis on separate hosts:

```yaml
# portainer-stack.yml
version: '3.8'
services:
  iptvo:
    image: itsoleglucic/iptvo:latest
    ports:
      - "${PORT:-3000}:${PORT:-3000}"
    environment:
      - ENCRYPTION_KEY=your-32-char-secret-key-here
      - DATABASE_URL=postgresql://user:pass@postgres-host:5432/iptvo
      - REDIS_URL=redis://redis-host:6379
      - LOGO_PROXY_URL=https://assets.oleglucic.com/iptvo/fetcher/logo
    restart: unless-stopped
```

---

### Local Development

```bash
# Install dependencies
npm install

# Set environment variables (using local Docker Compose for DB/Redis)
export ENCRYPTION_KEY="your-32-char-secret-key-here"
export DATABASE_URL="postgresql://iptvo:changeme@localhost:5432/iptvo"
export REDIS_URL="redis://localhost:6379"
export LOGO_PROXY_URL="https://assets.oleglucic.com/iptvo/fetcher/logo"

# Start server
node server.js
```

> **Tip**: Run `docker-compose up -d postgres redis` first, then start the Node server locally for fast iteration.

### Production (Portainer)

#### Using Pre-built Docker Image (`itsoleglucic/iptvo:latest`)

The pre-built image **requires external Postgres & Redis** — it does not include them.

### Option 1: Standalone Container (with external DB/Redis)

```bash
docker run -d \
  --name iptvo \
  -p 3000:3000 \
  -e ENCRYPTION_KEY="your-32-char-secret-key-here" \
  -e DATABASE_URL="postgresql://user:pass@postgres-host:5432/iptvo" \
  -e REDIS_URL="redis://redis-host:6379" \
  -e LOGO_PROXY_URL="https://assets.oleglucic.com/iptvo/fetcher/logo" \
  itsoleglucic/iptvo:latest
```

### Option 2: Portainer Stack (pre-built image + external DB/Redis)

In Portainer → Stacks → Add stack → Web editor:

```yaml
version: '3.8'
services:
  iptvo:
    image: itsoleglucic/iptvo:latest
    ports:
      - "${PORT:-3000}:${PORT:-3000}"
    environment:
      - ENCRYPTION_KEY=your-32-char-secret-key-here
      - DATABASE_URL=postgresql://user:pass@postgres-host:5432/iptvo
      - REDIS_URL=redis://redis-host:6379
      - LOGO_PROXY_URL=https://assets.oleglucic.com/iptvo/fetcher/logo
    restart: unless-stopped
```

### Option 3: Portainer Stack (pre-built image + local Postgres/Redis)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: iptvo
      POSTGRES_USER: iptvo
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U iptvo -d iptvo"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 2gb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  iptvo:
    image: itsoleglucic/iptvo:latest
    ports:
      - "${PORT:-3000}:${PORT:-3000}"
    environment:
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - DATABASE_URL=postgresql://iptvo:${POSTGRES_PASSWORD}@postgres:5432/iptvo
      - REDIS_URL=redis://redis:6379
      - LOGO_PROXY_URL=${LOGO_PROXY_URL:-https://assets.oleglucic.com/iptvo/fetcher/logo}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

Set these in Portainer stack **Environment variables**:

```text
ENCRYPTION_KEY=<32-char-secret>
POSTGRES_PASSWORD=<secure-password>
LOGO_PROXY_URL=https://assets.oleglucic.com/iptvo/fetcher/logo
```

---

#### Build from Source (using repo's docker-compose.yml)

1. Push repository to your Git host
2. In Portainer → Stacks → Add stack → Repository
3. Select repo, set `docker-compose.yml` as Compose path
4. Add same environment variables as above
5. Deploy — Portainer builds image locally, starts all services

## Cloudflare Workers (Required for Production)

IPTVo ships three Cloudflare Workers, all served coherently under `assets.oleglucic.com/iptvo/*`. Each is auto-deployed from this repository via **Workers Builds** (connect-to-GitHub in the Cloudflare dashboard):

| Worker | Code | Route | Purpose |
| ------ | ---- | ----- | ------- |
| `iptvo-root` | `logo-proxy.worker.js` | owns `assets.oleglucic.com` | domain anchor; serves `/logo` directly at the root |
| `iptvo-fetch` | `logo-proxy.worker.js` | `/iptvo/fetcher/*` | logo fetch via Cloudflare edge (avoids logo-host rate limits) |
| `iptvo-assets` | `iptvo-assets.worker.js` | `/iptvo/assets/*` | edge cache for posters, catalog/meta JSON, logos |

### One-time Setup (via Cloudflare dashboard)

1. **Workers & Pages → Connect to GitHub** → pick `oleglucic/IPTVo`.
2. Set the **Wrangler configuration file** per worker:
   - `iptvo-root` → `wrangler.toml`
   - `iptvo-fetch` → `wrangler.iptvo-fetch.toml`
   - `iptvo-assets` → `wrangler.iptvo-assets.toml`
3. Each worker's KV binding is declared in its config (`LOGO_KV` / `ASSETS_KV`, already created for you).
4. Enable **Caching** on both `iptvo-fetch` and `iptvo-assets` (default on) — they rely on it for 30-day edge caching.

**Set the logo URL in backend env:**

```bash
LOGO_PROXY_URL=https://assets.oleglucic.com/iptvo/fetcher/logo
```

### Worker Behavior

- **Fallback chain per URL**: primary logo → playlist `tvg-logo`/`stream_icon` → generated SVG placeholder
- **Rate limits**: Automatic 429 retry with exponential backoff (rate-limit protection for logo hosts)
- **Dead URLs**: Tracked in KV (24h TTL) to avoid retry storms
- **SVG placeholders**: Served inline (no external fetch), cached 30 days at edge
- **Caching**: Cloudflare CDN caches successful responses 30 days
- **CORS**: `Access-Control-Allow-Origin: *` for Stremio compatibility
- **Cold start optimization**: Pre-warms Redis logo buffer cache on startup

## User Authentication System

IPTVo includes a complete user authentication system with encrypted configuration storage, enabling multi-user deployments where each user gets their own addon URL.

### Architecture

```text
+-----------------------------------------------------------------+
|                            CLIENTS                               |
|   Stremio  /  Nuvio  /  Web Dashboard                           |
+---------------------------------+-------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------+
|                        EXPRESS  SERVER                          |
|   /api/auth/*      ->  User registration, login, session mgmt  |
|   /:userId/*       ->  Stremio addon endpoints (user system)    |
|   /:config/*       ->  Legacy base64 config endpoints           |
|   /health*         ->  Health checks (Docker)                   |
|   /api/get-groups  ->  Category discovery                       |
+---------------------------------+-------------------------------+
                                  |
              +-------------------+-------------------+
              v                   v                   v
+------------------+  +------------------+  +-----------------------+
|  POSTGRES        |  |  REDIS           |  |  CLOUDFLARE WORKERS   |
|  (Primary)       |  |  (Cache)         |  |  (edge assets)        |
| - users          |  | - channelMap     |  | - iptvo-root (domain) |
| - ai_overrides   |  | - logo buffers   |  | - iptvo-fetch (logos) |
| - epg_history    |  | - logo URLs      |  | - iptvo-assets (edge) |
| - logo_urls      |  |                  |  |  (edge cache + tiered)|
+------------------+  +------------------+  +-----------------------+
```

### Auth Flow

```text
Register:     POST /api/auth/register {username, password, config?} → {userId, token, config}
Login:        POST /api/auth/login {username, password} → {userId, token, config}
Validate:     GET  /api/auth/validate (Bearer token) → {valid, userId, config}
Update Config: PUT /api/auth/config (Bearer token) {config} → {success}
Change Pass:   PUT /api/auth/password (Bearer token) {current, new} → {success}
Delete Acct:  DELETE /api/auth/account (Bearer token) → {success}
Logo Proxy:   GET  /api/logo-proxy-url → {logoProxyUrl}
```

### Session Tokens

- Generated via `crypto.randomBytes(32).toString('base64url')`
- Stored in **Redis** (`nuvio:session:*`) with 30-day expiry — survives restarts and works across cluster workers
- Header: `Authorization: Bearer <token>`
- Config returned in auth responses (passwords/keys redacted)

### Config Encryption

- **Algorithm**: AES-256-GCM
- **Key derivation**: PBKDF2-SHA256 (100k iterations) from `ENCRYPTION_KEY` + per-user 16-byte salt
- **IV**: 12-byte random per encryption
- **Storage**: `encrypted_config` (base64), `config_iv` (base64), `config_salt` (base64) in `users` table
- **Per-user isolation**: Each user's config encrypted with unique salt

### Database Schema (Auto-initialized)

```sql
-- Users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,                    -- UUID
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,            -- PBKDF2: iterations$salt$hash
  encrypted_config TEXT,                  -- Base64 AES-GCM ciphertext
  config_iv TEXT,                         -- Base64 IV
  config_salt TEXT,                       -- Base64 salt
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- Persistent logo URL tracking
CREATE TABLE logo_urls (
  channel_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  source TEXT DEFAULT 'unknown',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Stremio Addon URLs

### New: User System (Recommended)

Each user gets a unique addon URL based on their `userId`:

```text
Manifest:     /:userId/manifest.json
Catalog:      /:userId/catalog/tv/iptvo_live.json
Meta:         /:userId/meta/tv/:id.json
Stream:       /:userId/stream/tv/:id.json
Poster:       /:userId/poster/:id.png
```

**Installation**: In Stremio → Addons → Community → Add addon → `http://your-host/<userId>/manifest.json`

### Legacy: Base64 Config (Backwards Compatible)

```text
Manifest:     /:config/manifest.json
Catalog:      /:config/catalog/tv/iptvo_live.json
Meta:         /:config/meta/tv/:id.json
Stream:       /:config/stream/tv/:id.json
Poster:       /:config/poster/:id.png
```

Where `:config` is the base64-encoded JSON config. The dashboard at `/` generates this.

## Dashboard

The web dashboard at `/` provides an **Apple HIG / Liquid Glass** (iOS 26/macOS 26) design:

- **Guided setup wizard**: 5 steps (Provider → Groups → Matching & AI → Backup → Save & Install) with a top-weekend sidebar/top bar
- **Mobile-first responsive**: Segmented control (<430px), tab bar (430-768px), sidebar (>768px)
- **Glassmorphism**: `backdrop-filter: saturate(180%) blur(20px)` with semantic color tokens
- **Authentication**: Login/register modal in the header (Cloudflare Turnstile bot protection)
- **Config management**: Save to DB, import/export JSON, change password, delete account
- **Group management**: Searchable list with include/exclude toggles, channel counts (auto-loaded once provider is set)
- **Sticky action bar**: Save & Install, Import, Export, Status (safe-area aware)

### Wizard Steps

| Step | Purpose |
| ----- | --------- |
| **Provider** | M3U/Xtream selection, URLs, credentials, timezone |
| **Groups** | Auto-loaded channel groups, search, include/exclude toggles |
| **Matching & AI** | iptv-org toggle, confidence slider, AI toggle + OpenRouter key |
| **Backup** | Export config JSON / import a saved one |
| **Save & Install** | Save config, view your private addon URL, copy to Stremio deep link |

## Configuration

The addon accepts configuration via the dashboard UI or direct URL parameters (legacy). Configuration is a JSON object:

```json
{
  "type": "m3u" | "xtream",
  "m3uUrl": "https://provider.com/playlist.m3u",
  "xtreamUrl": "https://provider.com",
  "username": "user",
  "password": "pass",
  "epg": "https://provider.com/epg.xml.gz",
  "include": ["Group A", "Group B"],
  "exclude": ["Group C"],
  "timezoneOffset": 0,
  "fallbackPreference": "custom",
  "iptvOrg": true,
  "ai": true,
  "openrouterKey": "sk-or-v1-..."
}
```

**Important**: `openrouterKey` is **mandatory** if `ai: true` (server env var deprecated). Enter it in the dashboard UI per-user.

In Stremio (legacy), paste the base64-encoded config into the addon configuration field. The dashboard at `/` provides a UI to generate this.

## Architecture: Channel ID Pipeline

For each raw channel from the provider:

```text
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

### Country Code Fallback

The parser extracts country codes from group names using a regex pattern (e.g., `�������� USA`, `[UK]`, `United States`, `(CA)`), normalizes to ISO-3166-1 alpha-2, and falls back through: `US` → `CA` → `GB` → `DE` → `FR` → `global` for iptv-org lookup. This significantly improves match rates for international channel packages.

## Logo Pipeline

```text
getPremiumPoster(cId, logoUrl, fallbackUrl, channelName)
  |
  |- 1. In-memory cache (30 min) - fastest
  |
  |- 2. Redis logo cache (7 days) - survives restarts
  |
  |- 3. Cloudflare Worker proxy - handles rate limits, fallbacks, edge cache
  |     |- Try iptv-org authoritative logo
  |     |- Try playlist fallback logo
  |     `- Return SVG placeholder
  |
  `- 4. Generate SVG fallback (no external calls)


**Cold-start optimization**: On server startup, Redis logo buffers are pre-warmed via background job (100 concurrent fetches, respects rate limits) to reduce first-request latency.

## Key Files

| File | Purpose |
| ------ | --------- |
| `server.js` | Express routes, auth, Stremio addon, health endpoints, cold-start pre-warm |
| `iptvParser.js` | Core M3U/Xtream parsing, channel ID pipeline, country extraction, XMLTV/EPG mapping, AI queue |
| `iptvOrgRef.js` | iptv-org data fetch + exact/fuzzy lookup (daily refresh) |
| `aiCurator.js` | AI deduplication queue, OpenRouter integration, batching |
| `imageEngine.js` | Poster generation (Sharp), logo cache, Worker proxy, SVG fallbacks |
| `db.js` | Postgres pool, user CRUD, override CRUD, EPG history, logo URL tracking |
| `dbInit.js` | Auto-initialize database schema on startup |
| `redisCache.js` | Playlist cache read/write, logo buffer persist/get, pre-warm job |
| `catchup.js` | Catch-up metadata extraction (M3U `catchup`/`catchup-days`, Xtream) |
| `cryptoUtils.js` | AES-GCM encryption/decryption, PBKDF2 password hashing, session tokens |
| `logo-proxy.worker.js` | Cloudflare Worker logo fetcher with KV dead URL tracking |
| `iptvo-assets.worker.js` | Cloudflare edge asset cache (posters, catalog/meta JSON) |
| `wrangler.toml` | Worker config for `iptvo-root` (KV bindings, compatibility date) |
| `wrangler.iptvo-fetch.toml` | Worker config for `iptvo-fetch` (logo fetcher) |
| `wrangler.iptvo-assets.toml` | Worker config for `iptvo-assets` (edge asset cache) |
| `dashboard/index.html` | Apple HIG/Liquid Glass tabbed UI, auth integration |
| `docker-compose.yml` | Container orchestration |

## Docker

Pre-built multi-arch images available on Docker Hub and GitHub Container Registry:

```bash
# Docker Hub
docker pull itsoleglucic/iptvo:latest
docker pull itsoleglucic/iptvo:v1.2.3

# GitHub Container Registry
docker pull ghcr.io/oleglucic/iptvo:latest
docker pull ghcr.io/oleglucic/iptvo:v1.2.3
```

To run:

```bash
docker run -d \
  --name iptvo \
  -p 3000:3000 \
  -e ENCRYPTION_KEY="your-32-char-secret-key-here" \
  -e DATABASE_URL="postgresql://user:pass@host:5432/dbname" \
  -e REDIS_URL="redis://host:6379" \
  -e LOGO_PROXY_URL="https://assets.oleglucic.com/iptvo/fetcher/logo" \
  itsoleglucic/iptvo:latest
```

### Building from source

```dockerfile
FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig fonts-inter fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm prune --omit=dev
EXPOSE 3000
CMD ["node", "server.js"]
```

Font packages are required for Sharp text rendering (poster initials badge).

## Environment Variables

| Variable | Required | Description |
| ---------- | -------- | ------------- |
| `ENCRYPTION_KEY` | Yes | 32+ char secret for AES-GCM config encryption |
| `DATABASE_URL` | Yes | Postgres connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `LOGO_PROXY_URL` | Yes* | Cloudflare Worker logo proxy URL (required for production) |
| `PORT` | No | Server port (default: 3000) |
| `CLUSTER_WORKERS` | No | Horizontal scaling: `0` = single process (default), `auto` = half the CPU cores, or an explicit worker count. Requires the cluster build. |
| `ASSET_BASE_URL` | No | Base URL for posters/logos/catalog links when served via the Cloudflare assets Worker+edge instead of the request host. Default: empty (use request origin). |
| `ADDON_CACHE_URL` | No | Addon-cache Worker URL (e.g. `https://addon-cache.worker.dev`) used by the `/api/_edge-purge` endpoint to drop stale edge pages after a re-parse. |
| `EDGE_PURGE_SECRET` | No | Shared secret guarding `POST /api/_edge-purge`. Unset disables the endpoint. |
| `EPG_HUB_CONCURRENCY` | No | Concurrent fetches for the central multi-source EPG hub (default 3, clamped 1–16). |
| `MAX_CONCURRENT_PARSES` | No | Max concurrent provider (M3U/Xtream) parses (default 4). |
| `PREWARM_CONCURRENCY` | No | Concurrent cache pre-warm fetches on startup (default 8). |
| `TURNSTILE_SECRET` | No | Cloudflare Turnstile secret for login/register bot protection. Unset disables the check (auth still works). |
| `TURNSTILE_HOSTNAMES` | No | Comma-separated hostnames the Turnstile token's source host must match (e.g. `iptvo.oleglucic.com`). Do NOT include `localhost`/`127.0.0.1` in production. |
| `OPENROUTER_API_KEY` | No** | Deprecated — use per-config `openrouterKey` instead |

*Required for production to avoid direct fetch rate limits. Optional for local dev (falls back to direct fetch).
**Server env var is deprecated. Provide OpenRouter key in dashboard config per-addon instance.

## Release Process

IPTVo uses **semantic versioning** with automated releases via GitHub Actions.

### Version Management

- Source of truth: `package.json` version
- Commits drive version bumps via `semantic-release` (in the Release job):
  - `feat:` → MINOR (the first `feat:` on a pre-1.0 project graduates straight to 1.0.0)
  - `fix:` → PATCH
  - `BREAKING CHANGE:` → MAJOR
  - Other prefixes (`docs:`, `chore:`, `refactor:`) → no version bump
- Every release's GitHub notes include a **🤝 Contributors** section (aggregated from commit authors + `Co-authored-by` trailers)

### Release Workflow (`.github/workflows/ci-cd.yml`)

Release runs on every push to `main` (CI + Release jobs in the same pipeline):

1. **Bump version** — `semantic-release` drives the version bump from commit prefixes (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE:` → major)
2. **Multi-arch Docker build** — linux/amd64, linux/arm64 via Buildx
3. **Push to registries** — Docker Hub (`itsoleglucic/iptvo`) + GHCR (`ghcr.io/oleglucic/iptvo`)
4. **Generate changelog** — from git log since last tag
5. **Create GitHub Release** — with changelog, Docker pull commands, addon URLs

### Manual Release

Releases are automatic: merging to `main` via a Pull Request triggers the Release job in `ci-cd.yml`, which bumps the version and publishes the Docker images + GitHub release. No manual tag creation or push is needed.

The changelog is generated automatically into `CHANGELOG.md` on each release.

### Required Secrets (GitHub Repository Settings)

| Secret | Purpose |
| -------- | --------- |
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token |
| `GITHUB_TOKEN` | Auto-provided, no setup needed |

### Changelog Format

See `CHANGELOG.md` — follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.

## Development Notes

- **No local Docker** — All Docker-dependent testing happens via git push + Portainer rebuild
- **Test before push** — Use `node -e` standalone scripts with real decoded production config against `streamFetchIPTV` directly
- **Two-pass M3U parsing** — Any variable computed on the `#EXTINF:` pass must be added to both the `cItem` construction AND the destructuring on the URL-line pass
- **XTream parsing is single-pass** — No scope issues there
- **Sensitive data redaction** — Never log passwords, openrouterKey, Authorization headers, or URLs with embedded credentials (replace `://user:pass@` → `://[REDACTED]@`)

## Health Checks

| Endpoint | Purpose |
| ---------- | --------- |
| `GET /health` | Basic liveness (Docker) |
| `GET /health/detailed` | Readiness with DB/Redis/Worker checks |
| `GET /health/startup` | Startup probe (longer timeout) |

## Support

IPTVo is developed and maintained by [Oleg Lučić](https://github.com/oleglucic). If this project saves you time or money, consider supporting future development:

- [Buy me a coffee on Ko-fi](https://ko-fi.com/oleglucic)

## License

MIT
