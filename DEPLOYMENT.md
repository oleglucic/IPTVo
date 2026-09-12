# Deploy IPTVo for $0/month

## Before you start

This path targets free tiers (Neon Postgres, Upstash Redis, Render). It is enough for light personal use. Heavy concurrency limiting or software transcoding needs a larger host — see [docs/streaming.md](docs/streaming.md).

## Create your database (Neon)

1. Create a Neon project and copy the connection string.
2. Set `DATABASE_URL` on the app.

## Create your cache (Upstash)

1. Create an Upstash Redis database.
2. Set `REDIS_URL` (use the TLS URL when provided).

## Fork and deploy (Render)

1. Fork the repo and connect it to Render (or use `render.yaml`).
2. Set secrets: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY` (32-byte hex).
3. Deploy and open `/health`.

## It's running, now what

- Open the dashboard, register, configure providers.
- Point Stremio/Nuvio at your addon URL (see root README).
- Optional: Cloudflare Workers for logos/assets ([WORKER_SETUP.md](WORKER_SETUP.md)).

## Known limitations of the free tier

- Sleeping dynos / cold starts on some free hosts.
- Limited CPU and bandwidth — leave `CONCURRENCY_LIMIT_ENABLED` and `TRANSCODE_ENABLED` off unless you need them.

## Upgrading later

Move Postgres/Redis to paid tiers or run `docker-compose.yml` on a VPS for always-on + local ffmpeg.

## Optional streaming features

Concurrency limiting and ABR transcoding are documented in **[docs/streaming.md](docs/streaming.md)**.

Both are **disabled by default**. On free-tier hosts, prefer leaving them off: relay and encode increase CPU and bandwidth. Enable only when you need provider stream limits or transcoding, and size the instance accordingly.

Quick enable (after reading the full guide):

```bash
CONCURRENCY_LIMIT_ENABLED=true
# TRANSCODE_ENABLED=true   # only if you need ABR encodes
```

Dashboard: set **Max concurrent streams your provider allows** when using concurrency limiting.
