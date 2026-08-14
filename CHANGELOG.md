# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- User authentication system with register, login, session management
- AES-256-GCM encrypted config storage with per-user salt/IV
- PBKDF2-SHA256 password hashing (100k iterations)
- Dual routing: user system (`/:userId/...`) and legacy base64 config (`/:config/...`)
- New auth endpoints: `GET /api/logo-proxy-url`, `PUT /api/auth/password`, `DELETE /api/auth/account`
- Dashboard tabbed UI with Apple HIG / Liquid Glass design (5 tabs: Provider, Matching & AI, Filters, Advanced, Sync)
- Mobile-first responsive design with segmented control / tab bar / sidebar variants
- Config import/export (JSON), change password, delete account in Sync tab
- Country code fallback extraction from group-title for improved iptv-org match rates
- SVG logo support in Cloudflare Worker proxy (inline, edge-cached)
- Cold-start Redis logo buffer pre-warm on server startup
- Automated release workflow with semantic versioning
- Multi-arch Docker builds (amd64/arm64) pushed to Docker Hub and GHCR
- GitHub Releases with changelog, Docker pull commands, addon URLs
- Auto-patch version bump on main branch pushes

### Changed
- `OPENROUTER_API_KEY` server env var deprecated → per-user config in dashboard
- Logo proxy URL now configurable via dashboard, served via `GET /api/logo-proxy-url`
- iptv-org matching uses country scope from group-title (previously global fallback only)
- Docker image namespace confirmed as `itsoleglucic/iptvo` on Docker Hub
- Dashboard completely redesigned from single-page form to tabbed Apple HIG interface
- Sticky bottom action bar on mobile (safe-area aware)
- Sensitive data redaction in all auth responses (passwords, keys, URLs with auth)

### Fixed
- SVG placeholder caching in Redis (was not cached, now stored as base64)
- iptv-org country code fallback chain (US → CA → GB → DE → FR → global)
- Cold-start latency via background Redis pre-warm job (100 concurrent fetches)
- Rate limit handling in logo proxy (429 exponential backoff with KV dead URL tracking)

## [0.0.1] - 2026-08-08

### Added
- Initial release
- M3U and Xtream Codes parsing
- Intelligent channel deduplication via iptv-org reference data
- AI curation fallback via OpenRouter (batched)
- Cloudflare Worker logo proxy with edge caching
- Redis logo cache (7-day TTL)
- Automatic poster generation with Sharp
- Catch-up TV support
- EPG integration with XMLTV SAX parser
- PostgreSQL persistence for AI overrides, EPG history, logo URLs
- Docker deployment with health checks
- Base64 config legacy addon endpoints
- Dashboard for config generation

### Fixed
- N/A (initial release)

---

## Release Notes Template

### [x.y.z] - YYYY-MM-DD

#### Added
- New features

#### Changed
- Changes to existing functionality

#### Deprecated
- Soon-to-be removed features

#### Removed
- Removed features

#### Fixed
- Bug fixes

#### Security
- Vulnerability fixes