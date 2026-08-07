# Contributing to IPTVo

Thank you for your interest in contributing! This project follows standard open-source practices.

## Development Workflow

1. **Fork the repository** on GitHub
2. **Create a feature branch** from `main`
3. **Make your changes** with clear, focused commits
4. **Test locally** before pushing:
   - Run `node -c` on modified files to check syntax
   - Test with a real decoded production config against `streamFetchIPTV` directly
5. **Push and open a Pull Request**

## Code Style

- ES modules not used — stick to CommonJS (`require`/`module.exports`)
- Match existing indentation (2 spaces), naming conventions, and comment density
- No linting config — follow the patterns in the existing codebase

## Two-Pass M3U Parsing

Any variable computed on the `#EXTINF:` pass must be added to **both**:
- The `cItem` construction on the `#EXTINF:` line
- The destructuring on the URL-line pass

XTream parsing is single-pass — no scope issues there.

## Testing

No local Docker — all Docker-dependent testing happens via git push + Portainer rebuild.

Use standalone scripts for verification:
```bash
node -e "require('./iptvParser').streamFetchIPTV('test', {...})"
```

## Commit Messages

Use conventional commit format:
- `feat:` new features
- `fix:` bug fixes
- `chore:` maintenance, deps, config
- `docs:` documentation updates
- `refactor:` code structure changes

## License

All contributions are licensed under the [MIT License](LICENSE).