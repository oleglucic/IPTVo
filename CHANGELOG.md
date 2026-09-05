## [2.1.1](https://github.com/oleglucic/IPTVo/compare/v2.1.0...v2.1.1) (2026-09-05)

### Bug Fixes

* resolve conventional-changelog-writer override conflict ([6e7db85](https://github.com/oleglucic/IPTVo/commit/6e7db852e214a2cc0d6187d94c7cd70d81e550f3))
* force conventional-changelog-writer v9 override for release-plugin ([cf49a26](https://github.com/oleglucic/IPTVo/commit/cf49a26f388d93a3b9ebd5a776e546e5e4da8392))
* correct secret references in top-level env block ([306e3ae](https://github.com/oleglucic/IPTVo/commit/306e3ae9a678d871287bda6adb21c97dd4b846db))
* replace secrets with env context in step conditions ([f639efa](https://github.com/oleglucic/IPTVo/commit/f639efa49cd3f107dced83e039ee7dad3981efd6))
* replace secrets context with env context in workflow ([6b1bc92](https://github.com/oleglucic/IPTVo/commit/6b1bc926e1f6045ca19980ee1e2afda6a59e5fcf))
* update actions/checkout to v7 SHA in all workflows for Node.js 24 compatibility ([0d9d752](https://github.com/oleglucic/IPTVo/commit/0d9d7526df792e1562ca364944d58d0798432835))
* update actions/checkout to v7 SHA in all workflows for Node.js 24 compatibility ([3748647](https://github.com/oleglucic/IPTVo/commit/3748647896cf81ea240d0553d304c7afd0e498af))
* use secrets in Release job conditions for Docker Hub/GHCR availability ([0479f05](https://github.com/oleglucic/IPTVo/commit/0479f053bd3027f2a531e2eb8283f0ed4defc788))
* make Release job conditional on Docker Hub/GHCR secrets availability ([f9e3177](https://github.com/oleglucic/IPTVo/commit/f9e3177daede41c07a9e859d1412b5c6420cf475))
* use client-id instead of deprecated app-id for GitHub App token ([ad66745](https://github.com/oleglucic/IPTVo/commit/ad66745c5a9be128d800ef37116338e15924d106))
* update create-github-app-token to v3.2.0 SHA for Node.js 24 compatibility ([3f19eb4](https://github.com/oleglucic/IPTVo/commit/3f19eb40c1f29bc1b15c3e704a6b96bdf1876ca7))
* update create-github-app-token to v3 for Node.js 24 compatibility ([5d8390c](https://github.com/oleglucic/IPTVo/commit/5d8390c96916cdd9d7a2cb4d4f981d2671de1000))
* update github-app-token to v1 for Node.js 24 compatibility ([9b8297e](https://github.com/oleglucic/IPTVo/commit/9b8297e1344d2ff25943b9e8efb26732e4035e2c))
* URL-encode username/password in Xtream live stream URLs ([05dd115](https://github.com/oleglucic/IPTVo/commit/05dd115448ce01d1ac471dd97a9472ee90d9a442))

## 🤝 Contributors

- Oleg lučić (@oleglucic)

## 2.1.0 (2026-09-02)

* ci: pin GitHub Actions to committed SHAs (supply-chain) ([a771a41](https://github.com/oleglucic/IPTVo/commit/a771a41))
* ci: add free gitleaks secret scan, actionlint, and dependabot config ([6f7560c](https://github.com/oleglucic/IPTVo/commit/6f7560c))
* ci: run Semgrep as informational (non-blocking) until findings triaged ([e1d9c16](https://github.com/oleglucic/IPTVo/commit/e1d9c16))
* ci: replace Fortify/JScrambler with free Semgrep SAST + integrity manifest ([da37f37](https://github.com/oleglucic/IPTVo/commit/da37f37))
* ci(actionlint): disable shellcheck integration to gate only workflow errors ([d14b5e0](https://github.com/oleglucic/IPTVo/commit/d14b5e0))
* ci(dependabot): add 7-day cooldown to wait out new/malicious package releases ([dc0f2f0](https://github.com/oleglucic/IPTVo/commit/dc0f2f0))
* fix: pass xtream creds as query params to satisfy CodeQL SSRF check ([7efe55a](https://github.com/oleglucic/IPTVo/commit/7efe55a))
* feat: dashboard fixes, redis logo corruption fix, SAST & code integrity CI ([01060b5](https://github.com/oleglucic/IPTVo/commit/01060b5))
* chore(deps-dev): bump fast-uri ([26726a1](https://github.com/oleglucic/IPTVo/commit/26726a1))

## 🤝 Contributors

- Oleg lučić (@oleglucic)

## 2.0.0 (2026-09-02)

* Merge pull request #55 from oleglucic/chore/dashboard-overhaul ([324b740](https://github.com/oleglucic/IPTVo/commit/324b740)), closes [#55](https://github.com/oleglucic/IPTVo/issues/55)
* refactor!: reorg backend into src/ and rename ai config key to aiEnabled ([c13e1aa](https://github.com/oleglucic/IPTVo/commit/c13e1aa))
* Merge remote-tracking branch 'origin/main' into chore/dashboard-overhaul ([756fdb4](https://github.com/oleglucic/IPTVo/commit/756fdb4))
* fix(parser,dashboard): audit fixes from code review ([66e2bd8](https://github.com/oleglucic/IPTVo/commit/66e2bd8))
* Merge branch 'main' into feat/community-matching ([ac338e7](https://github.com/oleglucic/IPTVo/commit/ac338e7))
* Tidy lint config and catalog handlers ([095ab0e](https://github.com/oleglucic/IPTVo/commit/095ab0e))
* Fix CodeRabbit issues in PR #54 ([0d687a5](https://github.com/oleglucic/IPTVo/commit/0d687a5)), closes [#54](https://github.com/oleglucic/IPTVo/issues/54)
* Merge branch 'main' into feat/community-matching ([0289eac](https://github.com/oleglucic/IPTVo/commit/0289eac))
* chore: untrack generated coverage output ([6ffb1a0](https://github.com/oleglucic/IPTVo/commit/6ffb1a0))
* chore(deps): override qs to 6.16.0 to fix audit failure ([b4a5b47](https://github.com/oleglucic/IPTVo/commit/b4a5b47))
* fix: resolve PR review findings (CodeRabbit + CodeQL) ([99819f9](https://github.com/oleglucic/IPTVo/commit/99819f9))
* fix: harden community matching and untrack coverage output ([6ea882e](https://github.com/oleglucic/IPTVo/commit/6ea882e))
* fix(deps): bump npm to 11.19.1 to resolve dev-dependency vulnerabilities ([840ef80](https://github.com/oleglucic/IPTVo/commit/840ef80))
* fix(release): repair generated release notes & contributor handles ([0adbcae](https://github.com/oleglucic/IPTVo/commit/0adbcae))
* refactor: reorganize repo, unify logging, honor aiEnabled ([4cc6bd0](https://github.com/oleglucic/IPTVo/commit/4cc6bd0))
* feat: community matching backend ([9e98f9c](https://github.com/oleglucic/IPTVo/commit/9e98f9c))
* feat(dashboard): in-app account dialogs, unsaved-changes guard, mobile polish ([e95bc4c](https://github.com/oleglucic/IPTVo/commit/e95bc4c))

### BREAKING CHANGE

* AI curation is now gated on aiEnabled (config key), not on
the presence of an openrouterKey. Set aiEnabled:true to keep AI on.
* custom integrations that require backend modules directly
must update paths from repo-root module files to src/<module>. Users with
legacy base64 configs that set ai:true are normalized to aiEnabled
automatically; anything reading the config as a raw object must use aiEnabled.

## 🤝 Contributors

- Oleg lučić (@oleglucic)

## 1.1.0 (2026-09-02)

* fix: harden community matching and untrack coverage output ([7cd97cb](https://github.com/oleglucic/IPTVo/commit/7cd97cb))
* fix(deps): bump npm to 11.19.1 to resolve dev-dependency vulnerabilities ([3924d0b](https://github.com/oleglucic/IPTVo/commit/3924d0b))
* fix(release): repair generated release notes & contributor handles ([6212aae](https://github.com/oleglucic/IPTVo/commit/6212aae))
* chore: untrack generated coverage output ([135393e](https://github.com/oleglucic/IPTVo/commit/135393e))
* Tidy lint config and catalog handlers ([be69602](https://github.com/oleglucic/IPTVo/commit/be69602))
* Fix CodeRabbit issues in PR #54 ([4c6515c](https://github.com/oleglucic/IPTVo/commit/4c6515c)), closes [#54](https://github.com/oleglucic/IPTVo/issues/54)
* Add files via upload ([1c567fa](https://github.com/oleglucic/IPTVo/commit/1c567fa))
* Fix CodeRabbit issues in PR #53 ([96df04d](https://github.com/oleglucic/IPTVo/commit/96df04d)), closes [#53](https://github.com/oleglucic/IPTVo/issues/53)
* various epg enrichment fixes ([a0592d7](https://github.com/oleglucic/IPTVo/commit/a0592d7))
* feat: community matching backend ([dbfd91d](https://github.com/oleglucic/IPTVo/commit/dbfd91d))
* feat: add community channel matching UI and API ([e223375](https://github.com/oleglucic/IPTVo/commit/e223375))

## 🤝 Contributors

- Oleg lučić (@oleglucic)

# [0.10.0](https://github.com/oleglucic/IPTVo/compare/v0.9.2...v0.10.0) (2026-08-21)


### Features

* **auth:** add Cloudflare Turnstile to login/register ([bc2c205](https://github.com/oleglucic/IPTVo/commit/bc2c205a17a4ecf009096b91808ef6fa19e5ae62))

## [0.9.2](https://github.com/oleglucic/IPTVo/compare/v0.9.1...v0.9.2) (2026-08-21)


### Bug Fixes

* **health:** guard cache-status keys so /health/detailed can't 500 ([4a7e989](https://github.com/oleglucic/IPTVo/commit/4a7e98991c02f9e25f720b368825fecf95f929a8))


### Performance Improvements

* **cache:** serve last-good snapshot while a refresh is loading ([3c69c51](https://github.com/oleglucic/IPTVo/commit/3c69c515d5f4ad9d494af211443efde3009209dc))

## [0.9.1](https://github.com/oleglucic/IPTVo/compare/v0.9.0...v0.9.1) (2026-08-21)


### Bug Fixes

* **catalog:** coerce Stremio extra arrays so search/genre don't crash ([c5021bf](https://github.com/oleglucic/IPTVo/commit/c5021bf3001c45c23e5816e527de6bc1d5c0b306))

# [0.9.0](https://github.com/oleglucic/IPTVo/compare/v0.8.1...v0.9.0) (2026-08-21)


### Features

* **dashboard:** auto-load channel groups + persist group selection ([#30](https://github.com/oleglucic/IPTVo/issues/30)) ([56c5538](https://github.com/oleglucic/IPTVo/commit/56c5538dad5ec8e7e9546ebf2e77f2a51a7e5c69))

## [0.8.1](https://github.com/oleglucic/IPTVo/compare/v0.8.0...v0.8.1) (2026-08-21)


### Bug Fixes

* **auth:** preserve stored credentials when config save omits them ([f7d9b5f](https://github.com/oleglucic/IPTVo/commit/f7d9b5f25946807ae445b435d32dcb059fbf1dfb))

# [0.8.0](https://github.com/oleglucic/IPTVo/compare/v0.7.0...v0.8.0) (2026-08-21)


### Features

* **cache+epg+match+assets:** production-hardening for launch ([#27](https://github.com/oleglucic/IPTVo/issues/27)) ([36c3af9](https://github.com/oleglucic/IPTVo/commit/36c3af9243dab400f7f3e850ca526b07091e560a))

# [0.7.0](https://github.com/oleglucic/nuvio-iptv/compare/v0.6.0...v0.7.0) (2026-08-20)


### Features

* **dashboard:** match browser top bar to page theme ([90292db](https://github.com/oleglucic/nuvio-iptv/commit/90292dbff3c1cde51a6141b00d7293541d198633))

# [0.6.0](https://github.com/oleglucic/nuvio-iptv/compare/v0.5.0...v0.6.0) (2026-08-20)


### Features

* **image:** render square 1:1 posters tied to channel logo cache ([b4abdc2](https://github.com/oleglucic/nuvio-iptv/commit/b4abdc25d4241878a6ac4acdafadc1fc83a272cb))
* **manifest:** declare square posterShape so client placeholders match ([81d57d9](https://github.com/oleglucic/nuvio-iptv/commit/81d57d9147b3885d68476d653000060a17323b75))

# [0.5.0](https://github.com/oleglucic/nuvio-iptv/compare/v0.4.0...v0.5.0) (2026-08-20)


### Bug Fixes

* **curator:** bound AI queue CPU usage and prevent stacked cycles ([ec54028](https://github.com/oleglucic/nuvio-iptv/commit/ec54028161c98988a23b0e9dbc2272d5d66cd938))


### Features

* **dashboard:** live version badge and GitHub-backed changelog ([32b9ac8](https://github.com/oleglucic/nuvio-iptv/commit/32b9ac8e8dc1499811e0a20ef79676505219c3a2))

# [0.4.0](https://github.com/oleglucic/nuvio-iptv/compare/v0.3.0...v0.4.0) (2026-08-20)


### Bug Fixes

* apply CodeRabbit auto-fixes ([5a89b92](https://github.com/oleglucic/nuvio-iptv/commit/5a89b923625c533dd1241fce86e95e97fda2e680))


### Features

* **dashboard:** warm humane redesign, materialize motion, fix groups empty-state ([0f865d2](https://github.com/oleglucic/nuvio-iptv/commit/0f865d25666b4f03c8b538b3969945710803c595))

# [0.3.0](https://github.com/oleglucic/nuvio-iptv/compare/v0.2.4...v0.3.0) (2026-08-19)


### Features

* **dashboard:** mobile drawer, wizard prev/next nav, matching toggle fix ([d771512](https://github.com/oleglucic/nuvio-iptv/commit/d771512139b81877e69bd53ee3b2b75eb516382f))

## [0.2.4](https://github.com/oleglucic/nuvio-iptv/compare/v0.2.3...v0.2.4) (2026-08-19)


### Bug Fixes

* **security:** gate external-fetch endpoints behind auth and block redirects ([f284d43](https://github.com/oleglucic/nuvio-iptv/commit/f284d4396df500a893ed701df500fcb79af88094))
* **security:** revalidate redirect targets and fix SVG escaping ([a91ace5](https://github.com/oleglucic/nuvio-iptv/commit/a91ace59233ccaf6ccd2e15100b955216be02960))

## [0.2.3](https://github.com/oleglucic/nuvio-iptv/compare/v0.2.2...v0.2.3) (2026-08-19)


### Bug Fixes

* **curator:** thread per-user AI model through the curation queue ([7eae56f](https://github.com/oleglucic/nuvio-iptv/commit/7eae56f90152d81ad638f57db75aed6f563cc4b6))
* **dashboard:** auto-detect timezone, honor AI toggles/model, show username ([6c1219a](https://github.com/oleglucic/nuvio-iptv/commit/6c1219a193c5b84c192dcbf17462db8206de5bf0))
* **server:** add /api/test-config endpoint and surface username in auth responses ([c2d10de](https://github.com/oleglucic/nuvio-iptv/commit/c2d10deaecf1f004f6464b0713de6bc95356b1fa))

## [0.2.2](https://github.com/oleglucic/nuvio-iptv/compare/v0.2.1...v0.2.2) (2026-08-19)


### Bug Fixes

* **dashboard:** load assets from /dashboard so the root page is interactive ([b5df5ce](https://github.com/oleglucic/nuvio-iptv/commit/b5df5ce702b77a9017cba5417501dc52c947d65e))

## [0.2.1](https://github.com/oleglucic/nuvio-iptv/compare/v0.2.0...v0.2.1) (2026-08-19)


### Bug Fixes

* **db:** export pool so schema init and queries actually run ([2542c8f](https://github.com/oleglucic/nuvio-iptv/commit/2542c8f03c92694fcb5cf259c70916b7af1a80a0))

# [0.2.0](https://github.com/oleglucic/nuvio-iptv/compare/v0.1.1...v0.2.0) (2026-08-19)


### Bug Fixes

* **release:** scope App token to repository so ruleset bypass applies ([dbe8a5a](https://github.com/oleglucic/nuvio-iptv/commit/dbe8a5accdce6a51055fd6e0344e9b078f84b68e))
* **release:** use RELEASE_GITHUB_TOKEN PAT for semantic-release push to protected main ([977f07c](https://github.com/oleglucic/nuvio-iptv/commit/977f07cd784b479a12fc5995aae0efc235b6da27))
* **workflows:** correct pinned Docker action SHAs in release job ([9cd6036](https://github.com/oleglucic/nuvio-iptv/commit/9cd60369688903f92667c0d181434796c9c8af35))


### Features

* implement dashboard rewrite, testing, CI/CD workflows, branch protection, and code quality improvements ([#22](https://github.com/oleglucic/nuvio-iptv/issues/22)) ([c4322e3](https://github.com/oleglucic/nuvio-iptv/commit/c4322e3595f08f9267613e3e235d2bf629ca7f42))

## [0.1.1](https://github.com/oleglucic/nuvio-iptv/compare/v0.1.0...v0.1.1) (2026-08-16)


### Bug Fixes

* fix Docker build by installing all deps first then pruning dev deps ([45bee86](https://github.com/oleglucic/nuvio-iptv/commit/45bee86834a3508d962626b32e1d969321b17172))

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
