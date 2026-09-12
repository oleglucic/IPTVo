# Security Policy

## Reporting a Vulnerability

Please report security issues privately via GitHub Security Advisories for this repository, or contact the maintainer. Do not open a public issue for unreleased vulnerabilities.

## Scope

- Authentication, session tokens, and encrypted user config
- Path handling for posters, cache, and HLS relay sessions
- Secrets in CI and deployment configuration

## Supported Versions

Security fixes target the latest `main` release line.

## Security Model

- User configs are encrypted at rest with `ENCRYPTION_KEY`.
- Auth endpoints are rate-limited; Turnstile may be enabled when configured.
- Host allowlists can restrict poster URL generation behind reverse proxies.

## Streaming proxy

When concurrency limiting or transcoding is enabled, playlist and segment paths are constrained to UUID session directories under the HLS cache root. Relay routes check session ownership and apply rate limits. Report path-traversal or session-confusion issues via the process above.
