# Deploy IPTVo for $0/month

This deploys the whole app for $0/month using three free services — Render (hosting), Neon (database), Upstash (cache) — and the tradeoff is the app sleeps after 15 minutes of no traffic, taking 30–60 seconds to wake on the next request.

## Before you start

Free GitHub account (to fork), free Render account, free Neon account, free Upstash account. None of these three require a credit card at the free tier.

## Create your database (Neon)

1. Go to neon.tech → sign up
2. "Create a project"
3. Copy the connection string from the "Connection string" box on the project dashboard
4. Save it — it becomes `DATABASE_URL` in step 5

## Create your cache (Upstash)

1. Go to upstash.com → sign up
2. "Create Database"
3. Choose Redis
4. Copy the `rediss://` connection string (not the REST URL — the exact field label in their console is the connection string)
5. Save it — it becomes `REDIS_URL` in step 5

## Fork and deploy (Render)

1. Fork the GitHub repo
2. Go to render.com → sign up
3. "New" → "Blueprint"
4. Connect the fork. Render reads `render.yaml` and prompts for every `sync: false` variable.
5. Paste in `DATABASE_URL` and `REDIS_URL` from steps 3–4.
6. For `ENCRYPTION_KEY`, run `openssl rand -hex 32` in any terminal (or use any online SHA-256/hex generator if you don't have one) and paste the result. Click "Apply."

## It's running, now what

The app URL appears in the Render dashboard once the build finishes. The first request takes 30–60 seconds (free-tier wake-up).

**Do not set a `CLUSTER_WORKERS` environment variable** — the free tier only has a fraction of one CPU core, so multiple worker processes would only slow things down.

## Known limitations of the free tier

- The app sleeps after 15 minutes of idle traffic; the next request takes 30–60 seconds to wake.
- Neon's free tier caps at 0.5GB storage; the app auto-deletes EPG data older than 14 days to stay under this, but watch Neon's storage graph if you add many EPG sources.
- Upstash's free tier allows 500,000 Redis commands/month — fine for personal use, may need upgrading with many active users.

## Upgrading later

Render's cheapest paid tier removes the sleep behavior. Neon/Upstash paid tiers only matter if you exceed the caps in the section above (0.5GB storage on Neon, 500K Redis commands/month on Upstash).

---

## Files created

- `.env.example` — environment variable templates grouped by category
- `render.yaml` — Render Blueprint configuration
- `DEPLOYMENT.md` — this file

---

## Concurrency limiting (optional)

IPTVo can sit in the middle of every channel stream to track how many streams a user has open and enforce their IPTV provider's concurrency limit. This is **opt-in** and **disabled by default**.

### What it does

When enabled, instead of handing Stremio a raw provider URL, the server creates an HLS relay for each stream. This lets the server:

1. **Track active streams per user** — counts how many streams each user currently has open.
2. **Enforce provider limits** — each user configures `providerConcurrencyLimit` in the dashboard (0 = unlimited, which is the default).
3. **Show a countdown instead of an error** — when a user at their limit opens a new channel, they see a live countdown video ("Closing oldest stream in Ns") instead of a playback error.
4. **Seamless splice** — if they stay past the countdown, the server kills their least-recently-active stream and continues playing the new channel in the **exact same video stream** — no reload, no new URL.
5. **Cancel on leave** — if they leave the countdown screen before it finishes, the eviction is cancelled and the original stream keeps playing untouched.

### Requirements

- **ffmpeg must be installed** — the Dockerfile includes it. If running outside Docker, install ffmpeg on the host.
- **Redis required** — session tracking uses Redis (already a required dependency).
- **Bandwidth consideration** — enabling this means ALL streams (including ones that wouldn't otherwise need processing) are relayed through your server rather than played directly from the provider. This increases your server's bandwidth usage.

### Configuration

**Environment variables** (add to `.env`):

```bash
# Enable the feature (default: false)
CONCURRENCY_LIMIT_ENABLED=true

# Countdown duration in milliseconds (default: 15000 = 15 seconds)
CONCURRENCY_EVICTION_COUNTDOWN_MS=15000

# Idle timeout for active sessions in milliseconds (default: 45000 = 45 seconds)
CONCURRENCY_SESSION_IDLE_TIMEOUT_MS=45000
```

**Per-user setting** (in the dashboard, Step 1 — Provider):
- **Max concurrent streams your provider allows** — numeric input, default 0 (unlimited)
- Set this to whatever your IPTV provider allows (e.g., 1, 2, 3...). If 0, no limit is enforced.

### How it works

1. When Stremio requests a stream, the server checks the user's `providerConcurrencyLimit` and current active session count.
2. If under the limit (or limit is 0): creates a relay session, starts ffmpeg remuxing the upstream URL to HLS, returns the relay URL.
3. If at/over the limit: creates a relay session, starts a countdown video (black screen with live countdown text), returns the same relay URL shape.
4. The Stremio player polls the relay's `playlist.m3u8` and segment files. On each request, the server updates the session's "last activity" timestamp.
5. If the countdown finishes: server stops the ffmpeg for the evicted session, marks the new session as active, starts the real stream remux (appending to the existing playlist for seamless splice).
6. If the viewer leaves during countdown: the countdown session goes idle, the reaper (runs every 15s) detects it after a short grace period (4s), cleans up only the countdown session, and leaves the eviction target untouched.
7. Background reaper (every 15s) also cleans up any sessions idle for longer than `CONCURRENCY_SESSION_IDLE_TIMEOUT_MS` (default 45s for active, 4s for countdown).

### Notes

- The feature is completely opt-in. When `CONCURRENCY_LIMIT_ENABLED=false` (default), streaming behaves exactly as before — no changes to existing behavior.
- The countdown video is generated on-the-fly by ffmpeg using a black background with drawtext overlay.
- Real streams are remuxed (not transcoded) with `-c copy` — no quality loss, minimal CPU.
- Session state is stored in Redis with a 4-hour TTL safety net.