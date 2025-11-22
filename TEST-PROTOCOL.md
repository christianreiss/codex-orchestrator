# Test Protocol – 2025-11-22 (crane.alpha-labs.net)

## Scope
Manual verification of cdx wrapper + API after recent changes.

## Environment
- Host: crane.alpha-labs.net (root)
- Base URL: https://codex-auth.uggs.io
- cdx wrapper: 2025.11.22-1
- Codex CLI: 0.63.0

## Tests
1) Auth pull (no local auth)
   - Removed `/root/.codex/auth.json` and ran `./bin/cdx --version`.
   - Result: auth pulled successfully; status `Api OK`, no push needed.

2) Version check
   - Same run reported `status ok | local 0.63.0 | api 0.63.0`.

3) Wrapper version exposure
   - `./bin/cdx --version` shows wrapper `2025.11.22-1` (post-bump).

4) Dashboard responsive layout sanity
   - CSS adjusted for mobile stacked table; not manually browsed in this session.

## Notes
- Auth push path was not triggered during this session (local auth unchanged at runtime).
- SQLite paths removed; service remains MySQL-only.

## Outstanding
- Working tree has uncommitted changes (wrapper, admin UI, env doc cleanups, API tweaks, DB migration guard).
