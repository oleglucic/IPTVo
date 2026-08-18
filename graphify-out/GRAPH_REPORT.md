# Graph Report - nuvio-iptv  (2026-08-17)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 254 nodes · 411 edges · 12 communities (11 shown, 1 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `45bee868`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- server.js
- package.json
- imageEngine.js
- iptvParser.js
- db.js
- dependencies
- devDependencies
- iptvOrgRef.js
- logo-proxy.worker.js
- catchup.js
- eslint.config.js

## God Nodes (most connected - your core abstractions)
1. `parseM3uData()` - 18 edges
2. `parseXtreamData()` - 16 edges
3. `renderPoster()` - 13 edges
4. `keywords` - 11 edges
5. `startAiQueue()` - 10 edges
6. `backgroundLogoRefresh()` - 8 edges
7. `scripts` - 8 edges
8. `ensureCache()` - 7 edges
9. `lookupChannel()` - 7 edges
10. `getPremiumPoster()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `ensureCache()` --calls--> `loadCacheFromRedis()`  [EXTRACTED]
  server.js → redisCache.js
- `parseM3uData()` --calls--> `startAiQueue()`  [EXTRACTED]
  iptvParser.js → aiCurator.js
- `parseM3uData()` --calls--> `extractM3uCatchupInfo()`  [EXTRACTED]
  iptvParser.js → catchup.js
- `parseM3uData()` --calls--> `getAllOverrides()`  [EXTRACTED]
  iptvParser.js → db.js
- `parseM3uData()` --calls--> `isValidCountryCode()`  [EXTRACTED]
  iptvParser.js → iptvOrgRef.js

## Import Cycles
- None detected.

## Communities (12 total, 1 thin omitted)

### Community 0 - "server.js"
Cohesion: 0.07
Nodes (40): crypto, decryptConfig(), deriveKey(), encryptConfig(), generateSessionToken(), getMasterKey(), hashPassword(), verifyPassword() (+32 more)

### Community 1 - "package.json"
Cohesion: 0.05
Nodes (40): allowScripts, sharp@0.35.3, author, description, engines, node, keywords, license (+32 more)

### Community 2 - "imageEngine.js"
Cohesion: 0.10
Nodes (32): axios, base64urlEncode(), cacheDir, crypto, deadUrlCache, evictOldestIfOverCap(), fetchLogoDirect(), fetchLogoViaProxy() (+24 more)

### Community 3 - "iptvParser.js"
Cohesion: 0.12
Nodes (30): getLogoUrl(), setLogoUrl(), applySynonyms(), axios, backgroundLogoRefresh(), { extractM3uCatchupInfo, extractXtreamCatchupInfo }, getEpgText(), { getLogoUrl, setLogoUrl } (+22 more)

### Community 4 - "db.js"
Cohesion: 0.14
Nodes (17): axios, { getOverride, setOverride, getAllOverrides }, globalAiCache, { lookupChannel, lookupChannelFuzzy }, processAiBatch(), sanitizeForLog(), startAiQueue(), adjustConfidence() (+9 more)

### Community 5 - "dependencies"
Cohesion: 0.10
Nodes (21): axios, cors, express, express-rate-limit, fuse.js, ioredis, dependencies, axios (+13 more)

### Community 6 - "devDependencies"
Cohesion: 0.10
Nodes (21): commitlint, @commitlint/config-conventional, eslint, eslint-plugin-html, globals, husky, devDependencies, commitlint (+13 more)

### Community 7 - "iptvOrgRef.js"
Cohesion: 0.18
Nodes (13): axios, buildMatchResult(), channelIdToLogo, exactMatchMap, Fuse, isValidCountryCode(), lastRefreshed(), lookupChannel() (+5 more)

### Community 8 - "logo-proxy.worker.js"
Cohesion: 0.31
Nodes (11): base64urlDecode(), base64urlEncode(), escapeHtml(), fetch(), fetchWithRetry(), generatePlaceholderSvg(), isDeadUrlKV(), isValidHttpUrl() (+3 more)

### Community 9 - "catchup.js"
Cohesion: 0.31
Nodes (8): buildCatchupUrl(), extractM3uCatchupInfo(), extractXtreamCatchupInfo(), getCatchupStreams(), { saveEpgSnapshot, getEpgHistory }, snapshotAllEpgToHistory(), getEpgHistory(), saveEpgSnapshot()

## Knowledge Gaps
- **112 isolated node(s):** `crypto`, `{ addonBuilder, serveHTTP }`, `addonInterface`, `apiLimiter`, `app` (+107 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `devDependencies` to `package.json`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **What connects `crypto`, `{ addonBuilder, serveHTTP }`, `addonInterface` to the rest of the system?**
  _112 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06755260243632337 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.04878048780487805 - nodes in this community are weakly interconnected._
- **Should `imageEngine.js` be split into smaller, more focused modules?**
  _Cohesion score 0.0962566844919786 - nodes in this community are weakly interconnected._
- **Should `iptvParser.js` be split into smaller, more focused modules?**
  _Cohesion score 0.11895161290322581 - nodes in this community are weakly interconnected._