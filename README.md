# IPTVo — Stremio/Nuvio IPTV Addon

Self-hosted Stremio/Nuvio addon for live IPTV (M3U / Xtream Codes). Node.js/Express, Postgres, Redis, optional Cloudflare Workers, user auth with encrypted configs, and automated releases.

## Features

- **Multi-format support** — M3U playlists and Xtream Codes API
- **User authentication** — Register/login, session tokens, PBKDF2-SHA256, AES-256-GCM configs
- **Dual routing** — User system (`/:userId/...`) and legacy base64 config (`/:config/...`)
- **Intelligent deduplication** — iptv-org reference data, AI curation fallback
- **Logos and posters** — Cloudflare Worker proxy, Redis logo cache, Sharp posters
- **Catch-up and EPG** — Metadata from M3U/Xtream and XMLTV
- **Dashboard** — Guided setup wizard, channel matching, mobile-first UI
- **Docker and releases** — Multi-arch images, semantic-release to Docker Hub + GHCR
- **Optional concurrency limiting** — HLS relay, countdown eviction, provider caps ([docs/streaming.md](docs/streaming.md))
- **Optional ABR transcoding** — Ladder, codec/hwaccel, global encode cap ([docs/streaming.md](docs/streaming.md))

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/streaming.md](docs/streaming.md) | Concurrency limiting + ABR transcoding |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Free-tier Neon / Upstash / Render |
| [WORKER_SETUP.md](WORKER_SETUP.md) | Cloudflare Workers |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [CLAUDE.md](CLAUDE.md) | Agent / maintainer development notes |

## Quick start

### Prerequisites

- Node.js 20+ (local) or Docker
- Postgres and Redis
- `ENCRYPTION_KEY` (32+ character secret)

### Docker Compose (recommended)

```bash
cp .env.example .env
# Set ENCRYPTION_KEY and POSTGRES_PASSWORD in .env
docker compose up -d
```

See root `docker-compose.yml` for Postgres, Redis, and the app (writable `iptvo_cache` for posters/HLS).

### Local development

```bash
npm install
export ENCRYPTION_KEY="your-32-char-secret-key-here"
export DATABASE_URL="postgresql://iptvo:changeme@localhost:5432/iptvo"
export REDIS_URL="redis://localhost:6379"
node server.js
```

### Free-tier cloud

Step-by-step: [DEPLOYMENT.md](DEPLOYMENT.md).

## Cloudflare Workers

Production logo/assets edge path: [WORKER_SETUP.md](WORKER_SETUP.md).

Set `LOGO_PROXY_URL` to your worker logo endpoint when configured.

## Authentication and addon URLs

- Register/login via dashboard or `/api/auth/*`
- User addon URL: `http://your-host/<userId>/manifest.json`
- Legacy base64 config URLs remain supported

Configs are encrypted at rest (AES-256-GCM, per-user salt/IV).

## Dashboard

Web UI at `/` — provider setup, groups, matching, backup, install link, and channel matching panel.

## Environment variables

Required:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `ENCRYPTION_KEY` | Master key for config encryption |

Common optional: `PORT`, `LOGO_PROXY_URL`, `ASSET_BASE_URL`, `CLUSTER_WORKERS`, `LOG_LEVEL`, Turnstile keys.

Streaming (default **off**):

| Variable | Default | Description |
|----------|---------|-------------|
| `CONCURRENCY_LIMIT_ENABLED` | `false` | HLS relay + per-user limits |
| `CONCURRENCY_EVICTION_COUNTDOWN_MS` | `15000` | Countdown before eviction |
| `CONCURRENCY_SESSION_IDLE_TIMEOUT_MS` | `45000` | Active session idle timeout |
| `TRANSCODE_ENABLED` | `false` | ABR encodes |
| `TRANSCODE_RENDITIONS` | `1080,720,480,360` | Heights |
| `TRANSCODE_CODEC` | `h264` | `h264` / `hevc` / `av1` |
| `TRANSCODE_HWACCEL` | `none` | `none` / `nvenc` / `qsv` / `vaapi` |
| `TRANSCODE_VAAPI_DEVICE` | `/dev/dri/renderD128` | VAAPI device |
| `TRANSCODE_CRF` | `23` | Quality |
| `TRANSCODE_PRESET` | `veryfast` | Preset (mapped for nvenc/SVT-AV1) |
| `TRANSCODE_MAX_CONCURRENT_JOBS` | `2` | Global encode cap |

Full list: [`.env.example`](.env.example). Streaming detail: [docs/streaming.md](docs/streaming.md).

## Key modules

| Path | Role |
|------|------|
| `server.js` | HTTP API, auth, Stremio routes, relay |
| `src/iptvParser.js` | M3U/Xtream parse and matching |
| `src/streamSessions.js` | Redis concurrency sessions |
| `src/streamRelay.js` | ffmpeg remux / encode / countdown |
| `src/transcodeConfig.js` | Encode CLI args |
| `src/imageEngine.js` | Posters |
| `src/epgHub.js` | EPG |
| `dashboard/` | Web UI |

## Health

- `GET /health`
- `GET /health/detailed` (rate-limited)

## License

See [LICENSE](LICENSE).
