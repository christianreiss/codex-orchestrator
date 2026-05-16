# Codex Orchestrator — Complete `cdx` / `clx` Wrapper Bakery Rewrite

## Context

The current wrapper bakery is a string-substitution pipeline that produces two ~10k-line bash scripts (`bin/cdx` 11,132 lines, `bin/clx` 4,844 lines) from 51 fragment files (`bin/cdx.d/`, `bin/clx.d/`), then bakes per-host placeholders (`__CODEX_SYNC_API_KEY__`, `__CODEX_HOST_MODEL__`, `__CODEX_ADMIN_THEME__`, …) into the script at **every** `/wrapper/download` request via PHP `strtr()`. About 90% of the bash code is duplicated between cdx and clx. SHA256 is recomputed on every download. There are no direct unit tests for `WrapperService`, `InstallerScriptBuilder` (597 lines), or `SeedAuthScriptBuilder` (166 lines). Version is detected via regex against the rendered file (`/WRAPPER_VERSION="([^"]+)"/`) — no compile-time provenance. Admin theme (a UI concern) is baked into the shell script. Six env vars + six `versions` DB keys configure the system. Three database tables (`hosts`, `install_tokens`, `auth_seed_tokens`) participate.

It works, but it ossifies every change: adding a config knob means editing a bash fragment, both build scripts, the PHP bakery, the installer builder, the documentation, and praying nothing escapes wrong. Cold-start latency on big hosts is dominated by re-parsing the 351 KB shell script. The string-substitution approach can't carry typed structured data — only flat KV pairs. There is no signature on the baked artifact.

The **HTTP API contract stays compatible during transition** (parallel build, atomic swap). Existing hosts continue to bootstrap and run against the old wrapper while the new bakery is being built behind a feature flag, then a single commit swaps the routes and deletes the old code.

Outcome: a typed, testable, statically-compiled Go binary per engine (`cdx`, `clx`) that boots in <50 ms, reads its per-host configuration from a signed JSON file (no string substitution at runtime), and is delivered through a pre-baking server-side cache that only re-bakes on config change. Round-trip tests verify config → binary → orchestrator without spinning up a real host. The 16 k LOC of bash becomes ~3 k LOC of Go with a 100 % unit-test floor on the bakery.

---

## Tech stack (resolved)

| Layer | Choice | Rationale |
|---|---|---|
| Wrapper language | **Go 1.23+** (toolchain `1.23.x` pinned in `go.mod`) | User pick. Single static binary, cross-compile matrix, fast cold start, structured config, real testing framework. |
| Topology | **Two fully separate binaries** (`cdx`, `clx`) | User pick. Each lives in its own Go module under `wrappers/cdx/` and `wrappers/clx/`. Engine-specific code paths stay engine-specific. Cross-binary code sharing is *not* a project goal — modest copy-paste is acceptable in exchange for zero coupling. |
| Distribution | Per-arch prebuilt binaries served by the orchestrator | Built in CI (GitHub Actions matrix), checked into `storage/wrapper/v2/bin/<engine>/<os>-<arch>/v<version>/<binary>` (or pulled from GitHub Releases if size is an issue — see "Binary hosting" below). |
| Bootstrap shim | **POSIX `sh`** (~50 lines) | Downloaded by `curl … \| sh`. Tiny — only fetches config + binary then `exec`s. Verifies binary signature (Ed25519) before executing. |
| Per-host config | **Signed JSON** (`config.json` + `config.json.sig`) | Replaces bash placeholders. Typed, validatable, future-extensible. Ed25519 signature using a server-held key, verified by binary on startup. |
| Bakery cache | **`storage/wrapper/v2/cache/<host_id>/<config_version>/`** (filesystem) | Pre-baked at config change, served as static files. Cache key derives from `(host_id, config_version, binary_version)`. Old entries pruned on a schedule. |
| Bakery invalidation | **Event-driven** | Bumping a host's config row bumps `config_version`. Any change to `hosts.{api_key,fqdn,secure,model_override,reasoning_effort_override,curl_insecure,claude_model_override,…}` or to a global setting that affects baked output bumps `config_version` for the affected hosts (or all hosts for global). A single `AdminEventRepository` hook triggers re-bake. |
| CI / build | **GitHub Actions** matrix: `{linux,darwin,linux-musl} × {amd64,arm64}` | Cross-compile per-arch binaries, sign with a CI-held private key, publish artifacts. A Make target reproduces builds locally. |
| Config schema | **Versioned JSON schema** (`schema_version: 1`) | Plus a Go struct (`internal/config.Config`) with `encoding/json` tags. JSON Schema lives in `wrappers/schemas/host-config-v1.json` and is used both server-side (PHP validation) and binary-side (golang.org/x/jsonschema or hand-rolled struct validate). |
| HTTP client (binary→server) | `net/http` with retries (`cenkalti/backoff/v5`) | Vendored. No `resty` / `req` etc. — keep deps minimal. |
| Logging | **`log/slog`** (stdlib) with `--silent` toggle | Structured logs go to stderr; stdout is reserved for engine passthrough. |
| Cobra | **No** — handcrafted `flag.NewFlagSet` per subcommand | Keeps binary small (~3 MB stripped) and dependency surface tiny. `cdx`/`clx` are dispatchers, not CLI frameworks. |
| Sandbox / exec | `os/exec` + targeted `unix.Setrlimit` calls | Codex sandbox semantics (Seatbelt on macOS, namespaces on Linux) are out of scope for this rewrite — invoke the upstream `codex` CLI which already implements them. The wrapper's job is config + transport, not sandboxing. |
| Tests | **Standard `testing` + `testify/require`** + golden-file tests | `internal/bakery/golden_test.go` round-trips real host fixtures through the baker. PHP side uses PHPUnit (already present). |

---

## What gets created

```
wrappers/                                       # NEW: Go workspace root, sibling of bin/, src/, public/
├── go.work                                     # workspace pointing at cdx/ and clx/
├── Makefile                                    # build, test, lint, release targets
├── README.md
├── schemas/
│   └── host-config-v1.json                     # JSON Schema for the per-host config blob
├── cdx/
│   ├── go.mod
│   ├── go.sum
│   ├── cmd/
│   │   └── cdx/
│   │       └── main.go                         # CLI entry. Subcommands: run (default), status, doctor, --version, --update, lane, profile, exec
│   └── internal/
│       ├── config/                             # Load + validate per-host config JSON
│       │   ├── config.go
│       │   ├── load.go                         # Reads $CDX_CONFIG_PATH, falls back to ~/.config/codex-orchestrator/config.json
│       │   ├── signature.go                    # Ed25519 verify
│       │   └── config_test.go
│       ├── orchestrator/                       # HTTP client to the orchestrator
│       │   ├── client.go
│       │   ├── auth.go                         # /auth retrieve/store, /sync/status, /sync/bootstrap
│       │   ├── usage.go                        # POST /usage
│       │   ├── lane.go                         # GET/POST /host/lane
│       │   ├── skills.go                       # GET /skills, POST /skills/retrieve
│       │   ├── agents.go                       # POST /agents/retrieve
│       │   ├── config_retrieve.go              # POST /config/retrieve
│       │   └── client_test.go
│       ├── codex/                              # Codex CLI invocation
│       │   ├── exec.go                         # Spawns `codex` with prepared env + args
│       │   ├── env.go                          # Builds the env block (model, reasoning effort, etc.)
│       │   ├── version.go                      # `codex -V` parsing
│       │   ├── doctor.go                       # diagnose / status
│       │   ├── auth_writer.go                  # Materializes ~/.codex/auth.json from server response
│       │   └── exec_test.go
│       ├── update/                             # Self-update logic
│       │   ├── update.go                       # Polls /wrapper/v2 metadata, downloads new binary, atomic swap
│       │   ├── verify.go                       # Verifies signature of downloaded binary
│       │   └── update_test.go
│       ├── ipc/                                # Single-instance lock, signal forwarding
│       │   ├── lock.go                         # flock-based per-host lock at $XDG_RUNTIME_DIR/cdx.lock
│       │   └── lock_test.go
│       ├── lifecycle/                          # Startup sequence: lock → version-check → auth-sync → skills/agents/config sync → exec
│       │   └── run.go
│       └── log/
│           └── log.go                          # slog setup honoring --silent + admin_theme color hint
├── clx/                                        # Same structure as cdx/, scoped to Claude engine
│   ├── go.mod
│   ├── go.sum
│   ├── cmd/clx/main.go
│   └── internal/
│       ├── config/                             # (intentionally duplicated; topology decision: fully separate)
│       ├── orchestrator/                       # Claude-specific endpoints + payload shapes
│       ├── claude/                             # `claude` / `claude-code` CLI invocation
│       ├── update/
│       ├── ipc/
│       ├── lifecycle/
│       └── log/
└── testdata/
    ├── host-codex.json                         # fixture: typical secure Codex host
    ├── host-codex-insecure.json
    ├── host-claude.json
    └── orchestrator-fixtures/                  # canned HTTP responses for orchestrator endpoints

src/Services/Wrapper/V2/                        # NEW: PHP-side bakery v2
├── ConfigBaker.php                             # Renders a per-host config JSON (replaces strtr placeholders)
├── ConfigSigner.php                            # Ed25519 signs the rendered JSON
├── BakeCache.php                               # Reads/writes cache entries under storage/wrapper/v2/cache/
├── BinaryRegistry.php                          # Discovers available binaries under storage/wrapper/v2/bin/
├── BootstrapShimBuilder.php                    # Renders the ~50-line POSIX sh shim
├── InstallerScriptBuilderV2.php                # New installer that runs the bootstrap shim
└── SeedAuthScriptBuilderV2.php                 # New seed-auth script (much smaller than the old one)

src/Http/Controllers/WrapperV2Controller.php    # NEW: GET /wrapper/v2[/meta|/config|/download|/bin]
src/Http/Controllers/InstallV2Controller.php    # NEW: GET /install/v2/{token}, /seed/v2/auth/{token}

src/Migrations/<timestamp>_wrapper_v2.php       # NEW: adds hosts.config_version, hosts.wrapper_track (legacy|v2), wrapper_keys (ed25519 keypair), bake_cache (optional DB-backed index)

storage/wrapper/v2/                             # NEW: cache + binaries
├── bin/
│   ├── cdx/
│   │   ├── linux-amd64/v0.6.0/cdx              # static binary
│   │   ├── linux-arm64/v0.6.0/cdx
│   │   ├── linux-musl-amd64/v0.6.0/cdx
│   │   ├── darwin-amd64/v0.6.0/cdx
│   │   ├── darwin-arm64/v0.6.0/cdx
│   │   └── manifest.json                       # platform → sha256, signature
│   └── clx/                                    # same shape
├── cache/
│   └── <host_id>/<config_version>/
│       ├── config.json
│       ├── config.json.sig
│       └── meta.json                           # baked_at, binary_version, etag
├── keys/
│   ├── signing.ed25519.pub                     # public key embedded in binary at build time
│   └── signing.ed25519                         # private key (chmod 600, not in git — see "Secrets")
└── README.md

.github/workflows/wrappers.yml                  # NEW: build matrix + signing + artifact upload

docs/
├── wrapper-v2-architecture.md                  # NEW
├── interface-cdx.md                            # MODIFIED (v2 contract added; v1 marked deprecated)
└── interface-clx.md                            # MODIFIED
```

---

## What gets deleted (in the final atomic-swap commit)

```
bin/cdx                                         # ~351 KB monolith, replaced by Go binary
bin/clx                                         # ~157 KB monolith
bin/cdx.d/                                      # 20 fragment files
bin/clx.d/                                      # 31 fragment files
scripts/build-cdx.sh                            # fragment concatenator
scripts/build-clx.sh
src/Services/WrapperService.php                 # 322 lines
src/Support/InstallerScriptBuilder.php          # 597 lines
src/Support/SeedAuthScriptBuilder.php           # 166 lines
src/Http/Controllers/WrapperController.php      # 77 lines
src/Http/Controllers/InstallController.php      # 235 lines (or trimmed to delegate to v2)
storage/wrapper/cdx                             # baked v1 cache files (one per engine)
storage/wrapper/clx
tests/.../CdxWrapperAuthStoreStatusTest.php     # v1 wrapper tests (8 files, ~2 k LOC)
tests/.../CdxWrapperAuthUploadCommandTest.php
tests/.../CdxWrapperAuthValidationTest.php
tests/.../CdxWrapperClientVersionPolicyTest.php
tests/.../CdxWrapperConcurrentGuardTest.php
tests/.../CdxWrapperCronBehaviorTest.php
tests/.../ClxWrapperCronBehaviorTest.php
tests/.../AdminHostInstallerModeResponseTest.php
```

And these route entries in `public/index.php` (lines 613–619) get re-pointed to the v2 controllers:

```
GET  /wrapper              → WrapperV2Controller::meta
GET  /wrapper/download     → WrapperV2Controller::download   (now serves the shim, not the full script)
GET  /install/{token}      → InstallV2Controller::install
GET  /seed/auth/{token}    → InstallV2Controller::seedAuthScript
POST /seed/auth/{token}    → InstallV2Controller::seedAuthStore
```

The v2 endpoints (`/wrapper/v2/*`, `/install/v2/*`, `/seed/v2/auth/*`) **stay** as the canonical paths; the unversioned routes alias to them.

What is **kept** (not affected by this rewrite):
- The whole `/auth`, `/sync/*`, `/host/*`, `/usage`, `/skills`, `/agents/retrieve`, `/config/retrieve` API surface that the wrapper *talks to* — these are stable contracts the new Go binaries consume verbatim.
- `Installation::ensure()`, `VersionRepository`, `HostRepository`, `InstallTokenRepository`, `AuthSeedTokenRepository`.
- All admin endpoints under `/admin/*`.
- The PHP `MEMORY.md`, `AGENTS.md`, runtime configuration system.

---

## Architecture (binary side)

### Startup sequence for `cdx`

```
1. Parse argv → subcommand (default: run)
2. Acquire single-instance lock at $XDG_RUNTIME_DIR/cdx.lock (or /tmp/cdx-$UID.lock)
   ├─ If held by another PID: exit 1 with structured error
   └─ Honour SIGTERM / SIGINT to release lock cleanly
3. Load config: $CDX_CONFIG_PATH || ~/.config/codex-orchestrator/cdx.json
   ├─ Read config.json + config.json.sig
   ├─ Verify Ed25519 signature against the embedded public key
   ├─ Validate schema_version == 1
   └─ Reject if any required field missing
4. Background: version check (non-blocking)
   ├─ HEAD /wrapper/v2/bin/cdx/<os>-<arch>/manifest.json
   ├─ If ETag differs and auto_update=true: schedule background download for next run
   └─ Never blocks foreground execution
5. Auth sync (if applicable)
   ├─ POST /auth { command:retrieve, digest:<sha256 of local ~/.codex/auth.json> }
   ├─ If status=outdated: write new auth.json atomically
   └─ If status=missing: prompt user (interactive) or exit (non-interactive)
6. Resource sync (in parallel, with timeouts)
   ├─ POST /skills/retrieve for each managed skill
   ├─ POST /agents/retrieve
   └─ POST /config/retrieve (writes ~/.codex/config.toml if changed)
7. Exec the upstream `codex` binary with the prepared env + argv
   ├─ Forward stdout/stderr unchanged (except colour stripping if --silent)
   ├─ Forward signals (SIGINT, SIGTERM) to child
   └─ Record exit code, propagate
8. On exit: POST /usage with input/output/cached/reasoning token counts (parsed from stderr or codex's --json output)
```

### Per-host config schema (JSON Schema fragment)

```json
{
  "schema_version": 1,
  "engine": "codex",
  "issued_at": "2026-05-16T10:00:00Z",
  "expires_at": "2026-06-16T10:00:00Z",
  "orchestrator": {
    "base_url": "https://orch.example.com",
    "api_key": "sk-host-...",
    "ca_bundle_path": null,
    "allow_insecure": false,
    "installation_id": "..."
  },
  "host": {
    "id": 42,
    "fqdn": "host01.example.com",
    "secure": true
  },
  "engine_options": {
    "silent": false,
    "model_override": "gpt-5.4",
    "reasoning_effort_override": "high",
    "admin_theme_hint": "auto"
  },
  "wrapper": {
    "version": "0.6.0",
    "track": "stable",
    "auto_update": true,
    "binary_url": "https://orch.example.com/wrapper/v2/bin/cdx/linux-amd64/v0.6.0/cdx",
    "binary_sha256": "..."
  }
}
```

`clx` uses the same schema with `engine: "claude"` and a Claude-shaped `engine_options` (no `reasoning_effort_override`).

### Subcommands (cdx)

| Subcommand | Purpose | Backing API |
|---|---|---|
| `run` (default) | Execute one Codex session, syncing first | the full startup sequence |
| `status` | Print summary (host, version, last sync, quota lane) | local config + `/sync/status` |
| `doctor` | Self-diagnostic: binary version, config validity, orchestrator reachability, codex CLI present, auth digest match | local + `/sync/status` |
| `--version` | Print wrapper version + binary sha256 (from build embed) | local |
| `--update` | Force binary self-update now | `/wrapper/v2/bin/...` |
| `lane <normal\|spark>` | Set this host's quota lane preference | `POST /host/lane` |
| `profile <name>` | Switch active Codex profile (forwarded to upstream codex CLI) | local + upstream |
| `exec -- <cmd...>` | Bypass interactive session; run a single Codex prompt non-interactively | upstream codex's headless mode |

### Subcommands (clx)

Same except `lane`/`profile` are absent (Claude has no quota lane and no profile system in this orchestrator). Plus `clx` accepts `claude-code` style args verbatim.

---

## Architecture (server side — PHP)

### `ConfigBaker::bakeForHost(int $hostId, string $engine): array`

1. Load the host row + global settings + version info.
2. Resolve engine-specific options (model override, reasoning effort, silent flag, admin theme).
3. Compose the JSON blob matching the schema.
4. Sign with Ed25519 key (loaded from `storage/wrapper/v2/keys/signing.ed25519`).
5. Compute SHA256 of canonical JSON.
6. Write to `storage/wrapper/v2/cache/<host_id>/<config_version>/{config.json, config.json.sig, meta.json}`.
7. Update `hosts.config_version` (atomic).
8. Return `[ "config_version" => int, "etag" => sha256, "size_bytes" => int ]`.

### `BakeCache::get(int $hostId, string $engine): ?array`

- Fast path: read existing cache entry by `(host_id, config_version)`.
- If absent: call `ConfigBaker::bakeForHost()` synchronously.
- If config_version is stale (host updated mid-request): re-bake.

### `BootstrapShimBuilder::build(int $hostId, string $engine, string $token): string`

Generates a tiny POSIX sh script:

```sh
#!/bin/sh
# wrapper-v2 bootstrap shim for cdx
set -eu
CONFIG_URL='https://orch.example.com/wrapper/v2/config?engine=codex'
BINARY_URL='https://orch.example.com/wrapper/v2/bin/cdx/<os>-<arch>/v<version>/cdx'
HOST_API_KEY='sk-host-...'
CDX_HOME="${CDX_HOME:-$HOME/.config/codex-orchestrator}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$CDX_HOME" "$BIN_DIR"

# 1) Fetch config (signed JSON)
curl -fsSL -H "X-API-Key: $HOST_API_KEY" -o "$CDX_HOME/cdx.json.new" "$CONFIG_URL"
curl -fsSL -H "X-API-Key: $HOST_API_KEY" -o "$CDX_HOME/cdx.json.sig.new" "$CONFIG_URL&sig=1"
mv "$CDX_HOME/cdx.json.new" "$CDX_HOME/cdx.json"
mv "$CDX_HOME/cdx.json.sig.new" "$CDX_HOME/cdx.json.sig"

# 2) Detect platform and ensure binary present
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac

# 3) Download binary if missing or wrong sha
expected_sha=$(jq -r .wrapper.binary_sha256 < "$CDX_HOME/cdx.json")
current_sha=$(sha256sum "$BIN_DIR/cdx" 2>/dev/null | cut -d' ' -f1 || true)
if [ "$expected_sha" != "$current_sha" ]; then
  curl -fsSL "$BINARY_URL" -o "$BIN_DIR/cdx.new"
  chmod +x "$BIN_DIR/cdx.new"
  mv "$BIN_DIR/cdx.new" "$BIN_DIR/cdx"
fi

# 4) Exec
exec "$BIN_DIR/cdx" --config "$CDX_HOME/cdx.json" "$@"
```

A single tool (`jq`) is the only non-coreutil dependency. The shim falls back to `python3 -c 'import json,sys; print(json.load(sys.stdin)["wrapper"]["binary_sha256"])'` if jq is missing — a tiny inline helper, no installer step required.

### `InstallerScriptBuilderV2`

The `/install/{token}` endpoint now emits:
1. A handful of env vars (BASE_URL, API_KEY, FQDN).
2. The bootstrap shim above, but written to `$HOME/.local/bin/cdx-shim` (a small file).
3. An optional one-time install of `codex` CLI (still needed — the wrapper invokes it). This part is mostly preserved from `InstallerScriptBuilder::install_codex_cli()` — call into a refactored `CodexCliInstaller.php` helper.
4. A first run of the shim to download config + binary.
5. Hint output explaining `cdx --version`, `cdx doctor`, next steps.

Total installer size: ~150 lines (down from 597).

### `SeedAuthScriptBuilderV2`

Same flow, smaller: just upload an existing `auth.json` to the server via `POST /seed/auth/{token}`. ~50 lines.

---

## Endpoints (v2)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/wrapper/v2/meta` | host API key | Return current binary version + sha256 + signing key fingerprint + supported platforms |
| GET | `/wrapper/v2/config` | host API key | Return per-host config JSON (signed). Adds `?sig=1` query for signature file. |
| GET | `/wrapper/v2/download` | host API key | Return bootstrap shim for this host (the same script the installer emits, minus the CLI install step). |
| GET | `/wrapper/v2/bin/{engine}/{platform}/v{version}/{binary}` | host API key | Serve static binary from `storage/wrapper/v2/bin/`. Cache-friendly (long TTL, ETag = sha256). |
| GET | `/wrapper/v2/manifest/{engine}` | host API key | Return per-platform `manifest.json` (sha256 + signature for each platform binary). |
| GET | `/install/v2/{token}` | none (token) | Emit installer script (consumes one-time token). |
| GET | `/seed/v2/auth/{token}` | none (token) | Emit seed-auth script. |
| POST | `/seed/v2/auth/{token}` | none (token) | Accept seeded auth payload. |

The legacy paths (`/wrapper`, `/wrapper/download`, `/install/{token}`, `/seed/auth/{token}`) **continue to work during transition**, served by the old controllers, until the atomic swap commit re-points them to v2 and deletes the v1 controllers in the same commit.

---

## Database changes

Migration `<timestamp>_wrapper_v2.php`:

```php
- hosts.config_version          BIGINT UNSIGNED NOT NULL DEFAULT 0
- hosts.config_baked_at         VARCHAR(40) NULL
- hosts.wrapper_track           ENUM('legacy','v2') NOT NULL DEFAULT 'legacy'
- new table: wrapper_signing_keys (id, algo, public_key, private_key_enc, active, created_at, rotated_at)
- new table: wrapper_v2_binaries (id, engine, os, arch, version, sha256, size_bytes, signature, published_at, uploaded_by)
```

`hosts.wrapper_track` lets you opt a single host to v2 for canary testing without flipping the global switch. Once flipped to `v2`, that host's `/wrapper/download` response returns the v2 shim. Default stays `legacy` until the atomic-swap commit, which then changes the default to `v2` and triggers a one-time backfill (`UPDATE hosts SET wrapper_track='v2'`).

---

## Secrets

- **Signing key**: Ed25519 keypair. Generated once with `openssl genpkey` and stored at `storage/wrapper/v2/keys/signing.ed25519` (chmod 600, owned by the web user). Backed up out of band. The **public** key is embedded into the Go binary at build time via `//go:embed`.
- **Rotation**: a second active key can be added to `wrapper_signing_keys`; the binary accepts any active key's signature. After all hosts have re-baked under the new key, the old key is retired.
- **Distribution**: the public key ships **inside the binary**. The binary verifies its own config; the orchestrator never has to push the public key. Rotation requires re-downloading the binary.

---

## Worktree-based execution plan

### Phase 1 — Foundation (sequential, single agent in worktree)

Branch: `cdx-redo/foundation`

1. Initialize the `wrappers/` Go workspace (`go.work`, two empty modules `wrappers/cdx`, `wrappers/clx`, shared `Makefile`).
2. Lay down the JSON schema (`wrappers/schemas/host-config-v1.json`) and a Go struct that matches.
3. Scaffold `src/Services/Wrapper/V2/` with empty class skeletons (`ConfigBaker`, `ConfigSigner`, `BakeCache`, `BinaryRegistry`, `BootstrapShimBuilder`, `InstallerScriptBuilderV2`, `SeedAuthScriptBuilderV2`).
4. Write the database migration adding `hosts.config_version`, `hosts.wrapper_track`, `wrapper_signing_keys`, `wrapper_v2_binaries`. Default `wrapper_track='legacy'` so nothing changes for live hosts.
5. Register v2 routes in `public/index.php` **alongside** the existing v1 routes (do not remove v1).
6. Add a `WrapperV2Controller` that responds to `/wrapper/v2/meta` with a stub.
7. Generate the Ed25519 keypair, write a one-time key-bootstrap script (`scripts/wrapper-v2-init-keys.sh`) that the operator runs once.
8. Build and commit the public-key embed file (`wrappers/internal/signing/pubkey.go`, generated from the public key with `//go:embed`).
9. CI scaffolding: `.github/workflows/wrappers.yml` matrix that runs `go test ./...` and `go build ./...` for both modules. No release publishing yet.
10. Phase 1 acceptance: `go test ./...` passes (with placeholder tests), PHP `composer test` passes (with the new migration applied), `/wrapper/v2/meta` returns a stub response.
11. Commit and merge to `main`.

### Phase 2 — Feature worktrees (parallel)

Each branches from post-Phase-1 main. Files are partitioned so conflicts are limited to: route table in `public/index.php` (append-only) and Go workspace tidy.

| # | Branch | Scope |
|---|---|---|
| 1 | `cdx-redo/binary-cdx-core` | `wrappers/cdx/cmd/cdx/main.go`, `internal/config/`, `internal/lifecycle/`, `internal/ipc/`, `internal/log/`. The `run` subcommand end-to-end against a mocked orchestrator. 100% unit-test coverage on config load + signature verify. |
| 2 | `cdx-redo/binary-cdx-orchestrator-client` | `wrappers/cdx/internal/orchestrator/` — all HTTP calls. Auth retrieve/store, sync/status, sync/bootstrap, lane get/set, usage post, skills, agents, config. Round-trip tests against `httptest.Server`. |
| 3 | `cdx-redo/binary-cdx-codex-exec` | `wrappers/cdx/internal/codex/` — invoke `codex` binary, parse versions, write auth.json, build env, doctor command. |
| 4 | `cdx-redo/binary-cdx-update` | `wrappers/cdx/internal/update/` — self-update with signature verification + atomic binary swap. |
| 5 | `cdx-redo/binary-clx-core` | Same as #1 but `wrappers/clx/`. Sister tree; deliberate (mostly) parallel implementation. Share *patterns* with cdx via copy-paste; share *code* via nothing. |
| 6 | `cdx-redo/binary-clx-orchestrator-client` | Claude-specific endpoint shapes; the `/auth?engine=claude` flow, `/sync/{status,bootstrap}?engine=claude`. |
| 7 | `cdx-redo/binary-clx-claude-exec` | `wrappers/clx/internal/claude/` — invoke `claude` / `claude-code`, parse versions, write `.claude/.credentials.json`. |
| 8 | `cdx-redo/binary-clx-update` | clx self-update. |
| 9 | `cdx-redo/server-bakery` | `src/Services/Wrapper/V2/` — `ConfigBaker`, `ConfigSigner`, `BakeCache`. PHPUnit tests using fixtures from `wrappers/testdata/`. Hooks into `AdminEventRepository` so any host mutation bumps `config_version`. |
| 10 | `cdx-redo/server-endpoints` | `WrapperV2Controller`, `InstallV2Controller`, route wiring, ETag/Cache-Control headers, response shape tests. |
| 11 | `cdx-redo/server-installer` | `BootstrapShimBuilder`, `InstallerScriptBuilderV2`, `SeedAuthScriptBuilderV2`. Snapshot tests against canonical fixtures. |
| 12 | `cdx-redo/ci-release` | GitHub Actions: build matrix for `{linux,darwin}-{amd64,arm64}` (+ optional `linux-musl-amd64`), sign each artifact, upload to a release. Add a local `make release` target that does the same locally for self-hosted builds. |
| 13 | `cdx-redo/canary` | Add an admin UI control (in the new WebUI under Settings → "Wrapper rollout") that flips `hosts.wrapper_track` per host. Smoke-test a real host pointed at `wrapper_track='v2'`. (Depends on the WebUI rewrite being in flight — Phase 2 can stub it as an API-only endpoint if the UI isn't merged yet.) |
| 14 | `cdx-redo/docs` | Rewrite `docs/interface-cdx.md`, `docs/interface-clx.md`, add `docs/wrapper-v2-architecture.md`. Update `DESIGN.md` § "Wrapper bakery" verbatim. |

Each agent receives this plan file plus a brief targeted to its scope. Agents do not touch each other's directories. The append-only files are: `public/index.php` (routes), `src/Migrations/*` (already done in Phase 1), `go.work` (Go workspace — agents 1-8 each add their module path here).

### Phase 3 — Cutover (sequential, single agent)

Branch: `cdx-redo/cutover`

1. Merge each Phase 2 branch into `cdx-redo/cutover` sequentially. Resolve any route-table conflicts mechanically.
2. End-to-end smoke test: bring up a real host pointed at `wrapper_track='v2'`. Run `cdx doctor`, `cdx run "echo hi"`, verify `/auth`, `/sync/status`, `/usage` all light up server-side.
3. **The atomic swap commit**: in one commit titled `chore(wrapper): cut over to v2 bakery`,
   - Re-point the legacy routes (`/wrapper`, `/wrapper/download`, `/install/{token}`, `/seed/auth/{token}`) to delegate to the v2 controllers.
   - Change the default of `hosts.wrapper_track` to `'v2'`.
   - Add a migration that backfills all existing hosts to `'v2'`.
   - Delete every file in the "What gets deleted" list above.
   - Drop the deleted PHPUnit test files.
4. Squash-merge to `main`.

### Phase 4 — Cleanup & hardening (sequential)

Branch: `cdx-redo/hardening`

1. Delete the temporary `wrapper_track` column and migration after one release of soaking with `'v2'` for every row (operator decision; not blocking).
2. Add structured tracing (OpenTelemetry) spans to the bakery and the binaries.
3. Add a Prometheus exporter on the binaries for usage counters (optional — guarded by config flag).

---

## Best-practice cull (the "weed out ALL" mandate)

What today's bakery does that the rewrite **stops doing**:

| Removed | Replaced with |
|---|---|
| 51 sorted bash fragments concatenated into a monolith | Go source tree split across small files, with `go vet` + `golangci-lint` |
| PHP `strtr()` on a 351 KB string at every download | One pre-baked JSON file per host; cache invalidated on config change |
| Regex-detected wrapper version from rendered output | Version embedded at build time via `-ldflags "-X main.Version=..."` |
| `auto-<sha>` fallback version label | Compile-time provenance only; build refuses to produce an unversioned binary |
| Plaintext placeholders in the script (`__CODEX_SYNC_API_KEY__`) | Typed signed JSON blob |
| No signature on baked artifact | Ed25519 signature on config; binary refuses to load tampered config |
| 90% duplication between cdx and clx scripts | Acknowledged duplication, but moved to Go where the duplication is visible and tooled (deliberate per topology decision) |
| Theme baked into shell script | `admin_theme_hint` in config (a colour hint for stderr only); UI concerns stay in the UI |
| Reasoning-effort legacy upgrade path in PHP (`ConfigNormalizer`) | Single normalized value in the JSON blob; legacy detection lives in `ConfigBaker` (one place) |
| Shell-escaping via custom `escapeBashDoubleQuoted` | `json_encode` (PHP) and `encoding/json` (Go) handle escaping for us |
| 597-line installer script builder | ~150-line `InstallerScriptBuilderV2` |
| 166-line seed-auth script builder | ~50-line `SeedAuthScriptBuilderV2` |
| Eight wrapper-touching PHPUnit tests, all integration | Direct unit tests on `ConfigBaker`, `ConfigSigner`, `BakeCache`, `BootstrapShimBuilder`, `InstallerScriptBuilderV2`, plus round-trip Go tests on every binary internal package |
| No round-trip verification | `wrappers/testdata/` golden files + `php artisan wrapper:bake-test --host=42` CLI command that re-bakes + diffs |
| Wrapper-seed-fallback rate-limit warning (300 s log throttle) | Hard failure: if the seed copy can't be written, the orchestrator fails the request with a 500 + sentry-able event |
| Wrapper SHA256 recomputed on every download | SHA256 stored in cache `meta.json`; served as `ETag` and `X-SHA256` headers without recomputation |
| Inline Python shim in seed-auth script | `jq` or POSIX-sh `case` parsing in the shim; no Python dependency on the host |
| Host-side `cdx` colour theme sequences embedded in 200+ lines of bash | `slog` JSON output by default; pretty output via stderr ANSI when `--silent=false` and terminal is a TTY |

---

## Verification

After every phase:

1. **Go side**: `cd wrappers && go vet ./... && go test ./... && go build ./...` — must pass for both modules.
2. **PHP side**: `composer test` — PHPUnit suite passes; `composer phpstan` — static analysis clean.
3. **End-to-end smoke** (Phase 2/3 only):
   - `docker compose up` brings the orchestrator + a clean test container.
   - Register a new host via `POST /admin/hosts/register?wrapper_track=v2`.
   - `curl /install/v2/<token> | sh` in the test container.
   - `cdx doctor` reports green for orchestrator reachability + auth digest + codex CLI present.
   - `cdx run -- "say hi"` returns a real Codex completion through `/auth` + upstream `codex`.
   - Bump a host setting in the orchestrator (e.g. flip `model_override`). Wait <1 s. The host's next `cdx run` picks up the new model (config re-baked, binary fetches it on startup).
4. **Signature integrity**: tamper with `~/.config/codex-orchestrator/cdx.json` (change a byte). Next `cdx run` exits with `config signature invalid`.
5. **Round-trip golden tests**: every fixture in `wrappers/testdata/` round-trips through `ConfigBaker` and produces a byte-identical config JSON. Drift in the baker shows up as a test diff.
6. **Cutover (Phase 3)**: after the atomic-swap commit, `grep -r "bin/cdx\.d\|InstallerScriptBuilder\|WrapperService" src/ public/ tests/` returns zero hits. `php public/index.php` boots cleanly. Existing legacy hosts (those upgraded by the backfill migration) bootstrap fresh on the v2 path.

---

## Files & references to consult during implementation

- **Scout report** (in this conversation thread) — full inventory of the v1 system.
- **Current API endpoints the binary will talk to** (do not modify): `src/Http/Controllers/AuthController.php`, `HostApiController.php`, `ConfigApiController.php`, `SkillApiController.php`, `ProjectApiController.php`, `WrapperController.php` (read for behaviour; deleted in the cutover).
- **Current bakery** (deleted in the cutover): `src/Services/WrapperService.php`, `src/Support/InstallerScriptBuilder.php`, `src/Support/SeedAuthScriptBuilder.php`, all of `bin/cdx.d/` and `bin/clx.d/`.
- **Database**: `src/Migrations/HostMigration.php` (host schema), `src/Repositories/HostRepository.php`, `VersionRepository.php`, `InstallTokenRepository.php`, `AuthSeedTokenRepository.php`.
- **Documentation**: `docs/interface-cdx.md`, `docs/interface-clx.md`, `DESIGN.md` — all updated in Phase 2 #14.
- **Upstream Codex CLI** (consumed by `cdx`): https://github.com/openai/codex — its `codex` binary semantics (model flag, profile flag, sandbox modes) are the contract `cdx` invokes.
- **Upstream Claude CLI** (consumed by `clx`): `claude-code` npm package — same contract role.
