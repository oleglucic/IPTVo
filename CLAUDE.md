# CLAUDE.md - Development Guidelines for IPTVo

## Project Overview

Self-hosted Stremio/Nuvio IPTV addon (Node/Express) with Postgres, Redis, optional Cloudflare Workers, concurrency-limited HLS relay, and optional ABR transcoding.

## Architecture

- `server.js` — HTTP routes, auth, catalog/stream/poster, relay/master when features enabled
- `src/` — domain modules (parser, EPG, image, redis, sessions, relay, transcode)
- `dashboard/` — static UI
- `docs/` — operator documentation index

## Key Files

- `server.js` — Express app entry
- `src/iptvParser.js` — M3U/Xtream parse and matching
- `src/db.js` / `src/dbInit.js` — Postgres access and schema
- `src/redisCache.js` — Redis client and caches
- `src/streamSessions.js` — Redis concurrency sessions
- `src/streamRelay.js` — ffmpeg relay / transcode processes
- `src/transcodeConfig.js` — encode argument builder
- `docs/streaming.md` — operator guide for streaming features
- `src/imageEngine.js` — poster generation
- `src/epgHub.js` — EPG aggregation

## Code Style

Match existing modules; prefer small focused files under `src/`.

## Security

Never log secrets, tokens, or full stream URLs with credentials. Path-contain session dirs for HLS.

## Common Tasks

### Add New DB Table

Update `src/dbInit.js` migrations and accessors in `src/db.js`.

### Add Auth-Protected Endpoint

Validate Bearer session from Redis; rate-limit sensitive routes.

### Login/Register Flow

See `server.js` `/api/auth/*` and dashboard auth modal.

### Stremio Addon URLs (User System)

`/:userId/manifest.json` and related catalog/meta/stream/poster routes.

### Legacy Addon URLs (Base64 Config)

`/:config/...` remains supported.

## Deployment

```bash
# Local
npm install && node server.js
# Docker
docker compose up -d
# Cloudflare Workers — see WORKER_SETUP.md
```

## Environment Variables

Required: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`.

Streaming (optional, default off): `CONCURRENCY_LIMIT_ENABLED`, `TRANSCODE_ENABLED`, `TRANSCODE_*` — see `docs/streaming.md` and `.env.example`.

## Testing

```bash
npm test
npm run lint
curl -s localhost:3000/health
```

## Sensitive Data Redaction Rules

Redact passwords, tokens, `ENCRYPTION_KEY`, and credential-bearing URLs in logs and errors.

## Branching Strategy

Feature branches from `main`; conventional commits; PR + CI green before merge.

## Release Process

Semantic-release on `main` via `.github/workflows/ci-cd.yml`.

## Commit Message Convention

`feat:`, `fix:`, `docs:`, `chore:`, etc.

## Versioning

SemVer from conventional commits.
