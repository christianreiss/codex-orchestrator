# TODO — wrapper bakery v2 follow-ups

Items left after the wrapper v2 rewrite landed on main. The current
architecture is documented in `docs/wrapper-v2-architecture.md`. None of these
block production; each is scoped tightly enough to do in a standalone
follow-up PR.

## Operational

- **Admin UI control for `hosts.wrapper_track`.** The column exists, the
  WrapperV2Controller honours `wrapper_track='disabled'` as a per-host
  kill-switch, but there is no admin UI button to flip the value yet. The new
  SvelteKit settings panels under `frontend/` should expose a toggle on the
  per-host detail page that POSTs to a new `/admin/hosts/{id}/wrapper-track`
  endpoint. (Plan item #13.)
- **Phase 4 hardening — OpenTelemetry spans on the bakery and the Go binaries.**
  Plan called these out as flag-guarded optional work; useful once a fleet is
  large enough that we want per-bake / per-startup distributed traces. Likely
  candidates: `ConfigBaker::bakeForHost`, `BakeCache::put`,
  `wrappers/<engine>/internal/lifecycle/run.go` (`Run`, `syncAuth`,
  `syncResources`).
- **Phase 4 hardening — optional Prometheus exporter on the binaries.** A
  `--metrics-addr=:9111` flag exposing wrapper counters (last-run age,
  exit-code histogram, bake-fetch latency). Off by default.

## Security / correctness

- **Multi-active-key signature verification.** `wrapper_signing_keys` already
  models multiple active rows for rotation, but the Go binaries verify against
  a *single* embedded pubkey. Rotating today means rebuilding + re-deploying
  binaries. Fix: have `ConfigBaker::bakeForHost` sign with the active key and
  embed the key fingerprint in the config; have the binary embed an array of
  pubkeys (newest + previous-N) and accept any matching signature. The
  fingerprint lookup short-circuits the verify loop.
- **Config `expires_at` enforcement.** Schema permits it, `ConfigBaker` writes
  `null`. Wire it: have the baker set a 30-day TTL and have the binary refuse
  configs past `expires_at`. Triggers a re-fetch via the bootstrap transition launcher.

## Polish

- **Round-trip golden fixtures under `wrappers/testdata/`.** Plan called for
  `host-codex.json`, `host-codex-insecure.json`, `host-claude.json`, and
  `orchestrator-fixtures/`. Today the Go and PHP tests use inline fixtures;
  the golden-file approach makes drift in `ConfigBaker` show up as a test
  diff. Cheapest path: dump three real-shaped configs into JSON files and
  have both sides assert byte-equality of the rendered config (after stripping
  `issued_at`).
- **`/wrapper/v2/manifest/{engine}` is wired and tested for shape, but there
  is no PHPUnit assertion that ETag headers match SHA256.** Add a controller
  test that boots the controller against a temp `storage/wrapper/v2/bin/`
  layout and verifies the headers.

## Cleanup (after one production release of v2 soaking)

- **Drop the `hosts.config_baked_at` column.** Currently informational only.
- **Drop the legacy `WRAPPER_STORAGE_PATH` / `WRAPPER_SEED_PATH` /
  `CLX_WRAPPER_*` env vars from `.env.example` and `docs/INSTALL.md`** — they
  are read by `WrapperService::__construct` for signature back-compat but
  ignored at runtime. Once nothing in the wider docs/scripts mentions them
  they can be dropped from the constructor too.
- **Stop seeding `versions['wrapper']` / `versions['wrapper_claude']` keys.**
  `WrapperService::ensureSeeded` still writes them so older callers don't
  break, but the v2 source of truth is `BinaryRegistry`.
