# CLAUDE.md - Development Guidelines for IPTVo

## Project Overview

IPTVo is a premium IPTV backend for Stremio/Nuvio that provides:
- AI-powered channel curation and deduplication via OpenRouter
- iptv-org authoritative channel matching (47k+ channels)
- Cloudflare Worker logo proxy with edge caching (30-day TTL)
- Redis-backed logo/image persistence (7-day TTL, survives restarts)
- AES-256-GCM encrypted user configs with password auth
- PostgreSQL for persistent overrides, EPG history, logo URLs
- Background EPG snapshots for catch-up support
- Docker deployment with health checks

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTS                                   │
│  Stremio / Nuvio / Web Dashboard                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      EXPRESS SERVER                              │
│  /api/auth/*      →  User registration, login, session mgmt    │
│  /:userId/*       →  Stremio addon endpoints (user system)     │
│  /:config/*       →  Legacy base64 config endpoints            │
│  /health*         →  Health checks (Docker)                    │
│  /api/get-groups  →  Category discovery                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│  POSTGRES     │  │    REDIS      │  │  CLOUDFLARE   │
│  (Primary)    │  │  (Cache)      │  │   WORKER      │
│               │  │               │  │  (Logos)      │
│ - users       │  │ - channelMap  │  │               │
│ - ai_overrides│  │ - logo buffers│  │ - edge cache  │
│ - epg_history │  │ - logo URLs   │  │ - rate limit  │
│ - logo_urls   │  │               │  │ - fallback    │
└───────────────┘  └───────────────┘  └───────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express server, auth, Stremio addon, health endpoints |
| `iptvParser.js` | M3U/Xtream parsing, iptv-org matching, AI queue |
| `imageEngine.js` | Poster generation, logo caching (memory→Redis→Worker→SVG) |
| `logo-proxy.worker.js` | Cloudflare Worker for logo fetching with fallbacks |
| `redisCache.js` | Redis persistence for channel cache & logo buffers |
| `db.js` / `dbInit.js` | PostgreSQL schema & queries |
| `cryptoUtils.js` | AES-GCM encryption, password hashing |
| `iptvOrgRef.js` | iptv-org reference data (daily refresh) |
| `aiCurator.js` | OpenRouter AI batching for unmatched channels |
| `dashboard.html` | Web UI for config management |
| `docker-compose.yaml` | Container orchestration |

## Code Style

- **CommonJS** (`require`/`module.exports`) - no ES modules
- **Async IIFE** for top-level await in `server.js`
- **No global state mutation** in modules - export functions
- **Error handling**: try/catch with logging, never throw in hot paths
- **Sensitive data redaction** in all logs (passwords, keys, URLs with auth)

## Security

- **ENCRYPTION_KEY** (32-byte, from env) required for user config encryption
- **OPENROUTER_API_KEY** per-user (not server env) - mandatory when AI enabled
- **DATABASE_URL** for PostgreSQL
- **REDIS_URL** for Redis cache
- **LOGO_PROXY_URL** for Cloudflare Worker endpoint
- Passwords: PBKDF2-SHA256 (100k iterations)
- Configs: AES-256-GCM with per-user salt + IV

## Common Tasks

### Add New DB Table
1. Add `CREATE TABLE` in `dbInit.js` statements array
2. Add query functions in `db.js`
3. Export new functions from `db.js`

### Add Auth-Protected Endpoint
```javascript
app.get('/api/protected', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({error: 'Unauthorized'});
    const token = authHeader.slice(7);
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) return res.status(401).json({error: 'Expired'});
    // Use session.userId, session.config
});
```

### Login/Register Flow
```
POST /api/auth/register {username, password, config?} → {userId, token}
POST /api/auth/login {username, password} → {userId, token, config}
GET  /api/auth/validate (Bearer token) → {valid, userId, config}
PUT  /api/auth/config (Bearer token) {config} → {success}
```

### Stremio Addon URLs (User System)
```
Manifest:     /:userId/manifest.json
Catalog:      /:userId/catalog/tv/iptvo_live.json
Meta:         /:userId/meta/tv/:id.json
Stream:       /:userId/stream/tv/:id.json
Poster:       /:userId/poster/:id.png
```

### Legacy Addon URLs (Base64 Config)
```
/:config/manifest.json → supports existing installations
```

## Deployment

```bash
# Local
npm install
cp .env.example .env  # Set ENCRYPTION_KEY, DATABASE_URL, REDIS_URL, LOGO_PROXY_URL
npm start

# Docker
docker-compose up -d

# Cloudflare Worker
# Deploy logo-proxy.worker.js via Cloudflare Dashboard or wrangler
# Set KV namespace binding: LOGO_KV
# Set env var: LOGO_PROXY_URL=https://your-worker.workers.dev/logo
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ENCRYPTION_KEY` | Yes | 32+ char secret for AES-GCM config encryption |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `LOGO_PROXY_URL` | Yes | Cloudflare Worker /logo endpoint |
| `PORT` | No | Server port (default 3000) |
| `OPENROUTER_API_KEY` | No | Deprecated - use per-user config |

## Testing

```bash
# Health check
curl http://localhost:3000/health

# Detailed health
curl http://localhost:3000/health/detailed

# Test config parsing
curl -X POST http://localhost:3000/api/test-config \
  -H "Content-Type: application/json" \
  -d '{"type":"m3u","m3uUrl":"https://example.com/playlist.m3u"}'
```

## Sensitive Data Redaction Rules

Never log these in plain text:
- Passwords (xtream, m3u auth)
- openrouterKey
- Authorization headers
- Full config objects
- URLs with embedded credentials (replace `://user:pass@` → `://[REDACTED]@`)

Use helper in routes:
```javascript
const safeConfig = {...config};
if (safeConfig.password) safeConfig.password = '[REDACTED]';
if (safeConfig.openrouterKey) safeConfig.openrouterKey = '[REDACTED]';
if (safeConfig.xtreamUrl) safeConfig.xtreamUrl = safeConfig.xtreamUrl.replace(/:\/\/[^@]*@/, '://[REDACTED]@');
```
