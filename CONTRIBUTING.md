# Contributing to IPTVo

## Development Workflow

1. Fork and branch from `main`.
2. Keep changes focused; open a PR with a clear summary and test notes.
3. Ensure CI (lint, tests, security scans) is green.

## Code Style

- Follow existing patterns in `server.js` and `src/`.
- Prefer small modules under `src/` for new subsystems.

## Two-Pass M3U Parsing

Playlist parsing is intentionally multi-pass for matching quality. Do not “simplify” by dropping passes without measuring match quality.

## Testing

```bash
npm test
npm run lint
node --check server.js
```

## Commit Messages

Conventional Commits (`feat:`, `fix:`, `docs:`, …). See root README release notes.

## Documentation

Operator and architecture notes live under [`docs/`](docs/README.md). Update those guides when you change concurrency limiting, transcoding, deployment, or public env vars.

## License

By contributing, you agree your changes are licensed under the same terms as the repository.
