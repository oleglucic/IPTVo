# Relay host + Auto stream labels

## Fixes in this branch

1. **src/redisCache.js** — export `redisClient` so `streamSessions` / `streamRelay` can use Redis (fixes 503 Session storage unavailable).
2. **server.js** — stream routes pass `streamRoot: posterRoot(req)` (app host).
3. **server.js** — Auto stream: `name: 'Auto'`, `title: streamTitle(bestStream)` (source stream description).
4. **server.js** — master playlist built with `posterRoot(req)`, not `assetRoot(req)`.

Redis logs showing healthy Redis do not contradict (1): catalog cache used the internal client; sessions imported a missing export.
