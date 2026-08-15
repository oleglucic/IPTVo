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

## Available Skills

**Global skills** (`~/.claude/skills/`) - available in all projects:
| Skill | When to Use |
|-------|-------------|
| `frontend-design` | Creating/modifying UI (dashboard.html, new web components) - design tokens, typography, motion |
| `code-simplifier` | Refactoring backend routes, database layers, complex logic - flatten async, HTTP timeouts, middleware |
| `karpathy-guidelines` | Before any non-trivial implementation - think first, edit surgically |
| `grill-me` | Before implementing new features - interrogate requirements |
| `webapp-testing` | Verifying changes in running app, API testing, browser automation |
| `handoff` | End of session - create HANDOFF.md for context preservation |
| `vercel-react-best-practices` | If React components added (currently vanilla JS project) |
| `redis/agent-skills` | Redis cache-aside patterns, TTL management, key naming, rate limiting for Stremio addons |
| `react-best-practices` | Building `/configure` pages in React/Tailwind for Stremio/Nuvio addons |
| `playwright-cli` | Browser automation for stream resolver testing, network capture, manifest extraction |

**Project-specific skills** (`.claude/skills/`) - only in this repo:
| Skill | When to Use |
|-------|-------------|
| `migrate-radix-to-base` | Migrating Radix UI → Base UI (if shadcn adopted) |
| `shadcn` | Managing shadcn/ui components (if adopted) |

### Skill Usage Workflow

1. **Before starting work**: Check if any skill applies to the task
2. **Invoke skill**: Use `Skill` tool with skill name (e.g., `Skill("redis/agent-skills")`)
3. **Follow skill guidance**: Apply its principles/methods
4. **Document decisions**: Use `handoff` skill at session end

### Example Invocations

```bash
# Before implementing a new feature
/grill-me "Add user channel favorites feature"

# Before refactoring parser
/code-simplifier

# When working on dashboard UI
/frontend-design

# When adding Redis caching
/redis/agent-skills

# At end of session
/handoff
```

## MCP Integration

All MCP servers are configured in the developer's instance. Available servers:
- **github**: PRs, issues, code review, repo management
- **postgres**: Schema inspection, queries, migrations
- **redis**: Cache inspection, key management, TTL checks
- **docker**: Container management, image builds
- **filesystem**: Codebase navigation, file operations
- **shell**: Command execution, scripts
- **playwright**: E2E testing, browser automation, network capture

### Usage
- Reference MCPs in prompts: "Use github MCP to create PR"
- MCPs auto-connect via developer instance - no local config needed
- Document MCP usage patterns in project-specific docs

## Branching Strategy

**Main branch**: Protected, always deployable, 1 approval required
**Feature branches**: `feat/<short-desc>` from `main`
**Release branches**: `release/vX.Y` for stabilization (when needed)
**Hotfix branches**: `hotfix/vX.Y.Z` from tags
**PR-based workflow**: All changes via PR with required checks
**Solo developer** - no team management needed
**Docker registry**: Correct (itsoleglucic/iptvo, ghcr.io/oleglucic/iptvo)

### Branch Naming Conventions
| Branch Type | Pattern | From | Merge To | Version Bump |
|-------------|---------|------|----------|--------------|
| Feature | `feat/<short-desc>` | `main` | `main` (via PR) | Auto (minor/major) |
| Bug Fix | `fix/<short-desc>` | `main` | `main` (via PR) | Auto (patch) |
| Hotfix | `hotfix/<version>` | tag `vX.Y.Z` | `main` + backport | Auto (patch) |
| Release | `release/vX.Y` | `main` | `main` (tag) | Manual (major/minor) |
| Docs | `docs/<short-desc>` | `main` | `main` | None |
| Chore/Refactor | `chore/<short-desc>` | `main` | `main` | None |

### Branch Protection
- Protect `main`: 1 approval, required checks (ci, codeql, codacy), linear history, no force push
- No auto-merge - manual merge after approval

## Release Process

**Change-based releases**: Release on every merge to `main`
- Pre-1.0: First `feat:` → 1.0.0 (major), then minor/patch
- Post-1.0: Standard semver (feat→minor, fix→patch, breaking→major)
- No time-based releases

**Automation**: Push to `main` → Auto-version → Auto-tag → Auto-release
- **Automation**: Conventional Commits → Auto-version → Auto-tag → Auto-release
- **Release types**: Patch (fix), Minor (feat), Major (breaking)

## Commit Message Convention

**Conventional Commits** (enforced via Husky + Commitlint):
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `build`, `ci`, `revert`, `security`

**Breaking Changes**: Add `BREAKING CHANGE:` to footer

**Examples**:
```
feat(auth): add user registration endpoint
fix(parser): handle malformed M3U entries
ci(docker): update base image to node:24
BREAKING CHANGE: drop support for Node 18
```

## Release Process

**Automation**: semantic-release on push to `main`
- **Zero-touch releases**: Push to `main` → Auto-version → Auto-tag → Auto-release
- **Release cadence**: Change-based (on merge to `main`)
- **Release types**: Patch (fix), Minor (feat), Major (breaking)

**Pre-1.0**: First `feat:` → 1.0.0 (major), then minor/patch
**Post-1.0**: Standard semver (feat→minor, fix→patch, breaking→major)

## Versioning

**Pre-1.0**: 0.x.x - First `feat:` → 1.0.0 (major), then minor/patch
**Post-1.0**: Standard SemVer 2.0.0

**Graduation to 1.0.0**: When ready (no strict timeline)
Criteria:
- [ ] All critical CodeQL alerts resolved (✅ path injection, ✅ log injection, ✅ SSRF, ✅ rate limiting, ✅ poster path injection)
- [ ] Test coverage ≥ 80%
- [ ] E2E tests for critical paths (auth, catalog, stream, poster)
- [ ] Documentation complete
- [ ] Performance benchmarks met (< 1.5s catalog response)

Process:
1. Create `release/v1.0` branch from `main` when ready
2. Stabilization period (bug bash, no new features)
3. Tag `v1.0.0` from `release/v1.0` → triggers major release
4. Post-1.0: Standard semantic-release on `main`
