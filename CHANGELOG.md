# [0.1.0](https://github.com/oleglucic/nuvio-iptv/compare/v0.0.1...v0.1.0) (2026-08-16)


### Bug Fixes

* add .npmrc to disable always-auth and fix npm ci optional dependencies ([4c98033](https://github.com/oleglucic/nuvio-iptv/commit/4c980339c59fc062bb467f164863033fbe41d7cb))
* address CodeQL security vulnerabilities ([abd57cd](https://github.com/oleglucic/nuvio-iptv/commit/abd57cddd38895fdb3e7f27a5ced8ffd3414ef04))
* address CodeQL security vulnerabilities ([e4c192e](https://github.com/oleglucic/nuvio-iptv/commit/e4c192e178b0df71e0f731d8d272738e19273d1d))
* apply remaining log injection fixes ([0367cc2](https://github.com/oleglucic/nuvio-iptv/commit/0367cc281cdb1eda91ea83f5c61228e7369a6884))
* apply security fixes and code quality improvements ([dee49a1](https://github.com/oleglucic/nuvio-iptv/commit/dee49a169bcb103335e277d5aa01d56d4780466c))
* change npm ci to npm install to properly resolve optional dependencies ([f703fb6](https://github.com/oleglucic/nuvio-iptv/commit/f703fb68be88b1edb2229fd93d5119d77c82c598))
* complete security fixes ([929c34e](https://github.com/oleglucic/nuvio-iptv/commit/929c34e2da215e76c09b0c089a25518b7c52ac6f))
* ioredis v6 RESP3 compat + codacy workflow v4 + Node 24 ([f784839](https://github.com/oleglucic/nuvio-iptv/commit/f7848392638aedf8947cbbdaf38be3b73a9386c1))
* prevent path injection in poster routes ([d04356a](https://github.com/oleglucic/nuvio-iptv/commit/d04356a53310c0a5ca99badbf4efef30fc7dfcba))
* ReDoS vulnerability in xtreamUrl redaction ([2e72f2f](https://github.com/oleglucic/nuvio-iptv/commit/2e72f2f93b636c9c6e3320b7eb1184daaa650ef5))
* remove always-auth from .npmrc - let setup-node handle auth ([ac3b2b1](https://github.com/oleglucic/nuvio-iptv/commit/ac3b2b166fcd974758c297115a983bb085a0ce2e))
* replace invalid semantic-release/action with npx semantic-release ([d135eff](https://github.com/oleglucic/nuvio-iptv/commit/d135eff2b6ea6ed6ba4693e2d1cacaf55f39c551))
* resolve npm vulnerabilities via overrides ([0c06877](https://github.com/oleglucic/nuvio-iptv/commit/0c068770c1da096e40c2f01f6e1b621e704291c4))
* sanitize all remaining console.error and console.log calls ([b9d22d5](https://github.com/oleglucic/nuvio-iptv/commit/b9d22d5b0063084e877fe8af291804c7f232d6d1))
* sanitize remaining log injection in ProactiveRefresh ([23600e6](https://github.com/oleglucic/nuvio-iptv/commit/23600e655ca0ae46cc5920c53720391a3be0c896))


### Features

* implement semantic-release, husky, commitlint, MCP docs, CI/CD ([64fdc1f](https://github.com/oleglucic/nuvio-iptv/commit/64fdc1f65d680076159bf6ad04a0f95ea4ad0faf))

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
