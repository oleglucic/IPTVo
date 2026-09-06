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