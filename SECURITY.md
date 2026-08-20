# Security Policy

## Reporting a Vulnerability

**Please do not open a public issue for a security vulnerability.** File a
private [security advisory](https://github.com/oleglucic/IPTVo/security/advisories/new)
instead, or email the maintainer directly.

We will acknowledge reports within five business days and aim to ship a fix
for confirmed vulnerabilities in the next patch release. Security issues are
handled confidentially until a patched version is available.

## Scope

In scope:

- The Express backend (`server.js`, `iptvParser.js`, related modules)
- The dashboard web UI (`/dashboard`)
- The Cloudflare Worker logo proxy (`logo-proxy.worker.js`)
- The Docker image and its deployment surface

Out of scope:

- Third-party IPTV providers and their content
- The Stremio client itself

## Supported Versions

| Version | Supported      |
| ------- | -------------- |
| latest  | Security fixes |
| older   | Best effort    |

## Security Model

- Live channel streams are fetched server-side, so provider credentials are
  never exposed to the client.
- User configs are encrypted at rest with AES-256-GCM using a
  per-user salt and IV.
- Outbound requests are validated against private, loopback, and cloud
  metadata address ranges (`isSafeUrl`) to block SSRF.
- All log output is redacted (`sanitizeForLog`) for passwords, keys, and
  credential-bearing URLs.
- All endpoint input is size-limited or rate-limited where cost could
  otherwise be abused by an unauthenticated caller.
