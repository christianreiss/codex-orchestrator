# cdx Wrapper Interface (Source of Truth)

## Build + Publish
- `cdx` is a static Go binary built from `wrappers/cdx/cmd/cdx/main.go` and the `wrappers/cdx/internal/...` packages.
- Build locally with `cd wrappers && make cdx`; cross-compile every platform with `cd wrappers && make release`.
- CI workflow `.github/workflows/wrappers.yml` runs `go vet` + `go test` + the cross-compile matrix on every push.
- The published binary lives under `storage/wrapper/v2/bin/cdx/<os>-<arch>/v<version>/cdx`; the orchestrator serves it from `GET /wrapper/v2/bin/cdx/<os>-<arch>/v<version>/cdx`.

## Distribution surfaces

| Method | Path | Returns |
|---|---|---|
| GET | `/wrapper/v2/meta` | per-platform manifest + signing fingerprint |
| GET | `/wrapper/v2/config[?sig=1]` | signed per-host config JSON (or detached signature) |
| GET | `/wrapper/v2/download` | raw Go binary for the calling host's detected platform |
| GET | `/wrapper/download` | legacy shell-transition launcher that writes v2 config, installs the binary, then execs it |
| GET | `/wrapper/v2/bin/cdx/<os>-<arch>/v<ver>/cdx` | the binary itself; ETag = SHA256 |

Config, download, and cron-check calls send `X-Wrapper-Platform: <os>-<arch>`
(`linux-amd64`, `linux-arm64`, `darwin-arm64`, or `darwin-amd64`) so the
orchestrator can bake the matching `binary_url` / SHA256 for this host.

## Per-host config (typed, signed)

The orchestrator's `api/src/services/wrapper-config.ts` produces a JSON blob
matching `wrappers/schemas/host-config-v1.json` and signs it with Ed25519. The
installer and the legacy transition launcher write the result to
`~/.config/codex-orchestrator/cdx.json` (and its detached signature next door).
On startup the Go binary verifies the signature against the public key embedded
at build time, then loads the config:

```jsonc
{
  "schema_version": 1,
  "engine": "codex",
  "issued_at": "...",
  "orchestrator": {
    "base_url": "https://orch.example.com",
    "api_key": "sk-codex-...",
    "ca_bundle_path": null,
    "allow_insecure": false,
    "installation_id": "..."
  },
  "host": {
    "id": 42,
    "fqdn": "host01.example.com",
    "secure": true,
    "browseros_mcp_enabled": false,
    "engines": "codex,claude",
    "engines_list": ["codex", "claude"]
  },
  "engine_options": {
    "silent": false,
    "model_override": "gpt-5.6-terra",
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

## Fleet model defaults

Settings → Codex and `GET/POST /admin/model-defaults/codex` manage the default
Codex CLI model and its model-dependent persistent effort. The endpoint writes
Codex's native top-level `config.toml` keys, `model` and
`model_reasoning_effort`, into the canonical Codex config document; this matches
the official Codex config schema rather than introducing wrapper-only names.
The fleet starts on `gpt-5.6-terra` at its native `medium` effort.

| Models | Persistent efforts | Default effort |
|---|---|---|
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `low` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` | `low`, `medium`, `high`, `xhigh` | `medium` |
| `gpt-5.3-codex-spark` | `low`, `medium`, `high`, `xhigh` | `high` |

The GET response's `catalog` is the machine-readable source of truth for these
model/effort pairs. POST accepts strict
`{model, reasoning_effort?: string|null}`; omitted/null effort selects the
model's default and unsupported combinations return 422. Per-host
`model_override` / `reasoning_effort_override` still take precedence when the
server bakes `~/.codex/config.toml`.

## CLI surface

| Subcommand | Purpose |
|---|---|
| `run` (default) | One Codex session; the full startup sequence runs first |
| `status` | Local config summary + remote `/sync/status` ping |
| `doctor` | Self-diagnostic (config, CLI present, auth, reachability) |
| `auth-upload` | POST the local `~/.codex/auth.json` to canonical store. `last_refresh` is backfilled with the current UTC RFC3339 stamp if the file lacks one (legacy `normalize_auth_json_file` parity). |
| `lane <normal\|spark\|clear>` | Set this host's quota lane (`/host/lane`) |
| `ls` | Shorthand for `cdx lane spark` |
| `profile <name>` | Forward `--profile <name>` to the upstream `codex` CLI |
| `<profile-name>` | Shorthand for `cdx profile <name>` when `[profiles.<name>]` exists in the synced `config.toml` and the token is not a wrapper-owned or reserved-Codex subcommand |
| `exec -- <cmd...>` | Bypass the startup sequence and run a single Codex command |
| `--help` / `-h` / `help` | Passed straight through to the upstream `codex` binary without running auth/sync/boot — handles `cdx --help`, `cdx help`, and `cdx <reserved-subcommand> --help` |
| `--resume <session>` / `--resume=<session>` | Passed through the normal startup lifecycle to the upstream `codex` binary |
| `--execute "<prompt>"` | Headless one-shot via `codex exec`; the boot screen is suppressed but auth + resource sync still run |
| `--cron [install\|remove\|run]` | Manage the optional host auto-update crontab entry (`run` is the action fired by cron itself); reports the upstream Codex CLI as a normalized semantic version even when `codex --version` prints a label such as `codex-cli 0.130.0`; cron ticks bootstrap `/usr/local/bin` into `PATH` before probing/updating Codex and, on dual-engine hosts, force one guarded `clx --cron run` peer tick so Claude Code is refreshed too |
| `--version` | Print version + commit + embedded pubkey status |
| `--update` | Self-update now (verifies SHA256 before swapping) |
| `--uninstall` | Remove auth + local state + cron entry; refuses on multi-user hosts without sudo |

## Peer engine reconciliation

After a successful startup sync, `cdx` reads the host `engines_list`. If Claude is
enabled, `cdx` fetches the signed `clx` config from
`/wrapper/v2/config?engine=claude`, writes `clx.json{,.sig}`, verifies the
served SHA256, and installs/updates the `clx` binary beside the running wrapper.
If Claude is disabled, `cdx` performs local-only full Claude cleanup (wrapper
binary/config/cron, managed `~/.clx`/Claude state, and the npm global Claude
Code package when detected) without deleting the host row.
During `cdx --cron run`, peer reconciliation also runs one guarded
`clx --cron run` tick even when the `clx` wrapper and `claude` CLI are already
present. The `CODEX_ORCH_PEER_SPAWN=1` guard prevents the peer tick from
recursing back into `cdx`, so one managed cdx cron entry keeps both wrappers and
both engine CLIs current on dual-engine hosts.

## Startup sequence

1. `flock` on `$XDG_RUNTIME_DIR/cdx.lock` (or `/tmp/cdx-<uid>.lock`) to enforce single-instance per host. If held, the wrapper enters read-only mode for managed AGENTS/config/skills writes and surfaces "Concurrent" on the boot screen with text picked from the auth-decision state. Auth is the exception: every run still submits the local auth digest and atomically writes server-returned canonical auth when the response is `outdated`/`updated`/`missing`, so a secondary run does not launch with stale local credentials. The `cdx` lock is independent from `clx.lock`; Codex and Claude sessions must not force each other into read-only mode.
2. Load the signed config; refuse to proceed if the Ed25519 signature is invalid. When `host.browseros_mcp_enabled=true`, the startup context shows a BrowserOS chip and synced `config.toml` contains the local BrowserOS HTTP MCP server entry.
3. Bundle sync (`POST /sync/bootstrap` with `include_auth=true`, `home`, `username`, AGENTS+config digests, and an optional `auth_candidate`) — auth + AGENTS + config in one round-trip. Resource envelopes are unwrapped before local writes, so `~/.codex/AGENTS.md` and `~/.codex/config.toml` contain only the served `content` bodies. On 404/501 the wrapper falls back to the legacy per-resource pulls (`/auth`, `/agents/retrieve`, `/config/retrieve`).
4. Pass the bundle response through the typed decision matrix (`internal/orchestrator/auth_decide.go`). Handles `valid`, `outdated`, `updated`, `unchanged`, `missing`, `upload_required`, `disabled`, `invalid`, `insecure` (opens the in-place approval-pending box, 5 s refresh), `insecure-denied`, `concurrent`, and `offline` (uses cached `auth.json` within 24 h, or 7 d on secure hosts). Honours `versions.api_disabled` and `installation_id` mismatch as hard stops. A server `verification_state=failed` (the background runner worker reached ChatGPT and the canonical token did not authenticate) overrides any green digest status: the launch is refused with a re-login message and the boot-screen `● auth` dot turns red. Startup does not wait on live runner verification; `/auth` and `/sync/bootstrap` report the latest stored worker verdict. When ChatGPT quota metadata is available, the boot screen shows current percent, reset time, and a burn-rate projection for the percent expected at reset.
4a. Interactive recovery: when the credentials failed live verification, or are missing/upload-required with no usable local file (or the server rejected the candidate), interactive `cdx run` prompts before launch, runs `codex login` on acceptance, uploads the resulting `~/.codex/auth.json` through `/auth command=store`, and re-runs the startup auth check. Launch proceeds only after the server accepts and verifies the new credentials. Non-interactive runs (cron, `--execute`) fail closed instead of opening a login flow.
5. Skills probe (`GET /skills?engine=codex`) — fingerprints the response, lights the boot-screen "skills" dot on change. Skills themselves are served via MCP `resource_read skill://<slug>`; on first boot of each wrapper version, the legacy on-disk caches (`~/.agents/skills`, `~/.codex/skills`, `~/.codex/prompts`) are pruned so they don't shadow MCP.
6. Runtime FQDN guard: compares `os.Hostname` against the baked FQDN; refuses unless `CODEX_ALLOW_FQDN_MISMATCH=1`.
7. Wrapper and Codex CLI version reconciliation — normal `cdx` startup updates the wrapper from the server-declared artifact when `versions.auto_update_enabled` is true, re-execs the original argv, then keeps the local Codex CLI on the server's declared target. `latest` is resolved against GitHub before download so current hosts do not redownload on every launch. The boot summary uses the same policy: non-exact latest/floor targets only show an arrow when the resolved target is newer than the local CLI. Never blocks launch.
8. Snapshot `auth.json` sha256 + `last_refresh`; `exec` the upstream `codex` CLI; forward stdio + signals.
9. Post-exit auth re-upload: if either the sha or `last_refresh` changed during the run (token rotation, `codex login`), POST the new payload to `/auth` store.

## Refusal modes

- Missing or tampered signature → `config signature invalid`; exit 2 without launching `codex`.
- `schema_version != 1` → `unsupported schema_version`; exit 2.
- `engine != "codex"` → `engine "..." not supported by this binary`; exit 2.
- Lock held by another PID with invalid local auth → "Active cdx run detected and local auth.json is invalid or absent."; exit 1.
- `versions.api_disabled=true` → "Auth API disabled by administrator."; exit 1.
- API kill-switch (`versions.api_disabled=true`) blocks startup before auth/config writes.
- `installation_id` mismatch → "Installation ID mismatch; refusing to sync."; exit 1.
- Reverse DNS mismatches are reported from `/auth` as a host/IP policy denial so operators can fix DNS instead of rotating credentials.
- Auth status `invalid` → "Invalid API key; download a fresh wrapper or rotate the key."; exit 1.
- Auth status `insecure` → approval pending; the wrapper keeps the in-place polling box open until approved or denied.
- Auth status `insecure-denied` → "Insecure host approval denied; re-run or open the host window."; exit 1.
- Auth status `offline` and cached auth older than 24 h (or 7 d on secure hosts) → "API offline and cached auth.json older than allowed window."; exit 1.
- Hostname mismatch with baked FQDN and no override env → "hostname X does not match baked FQDN Y (set CODEX_ALLOW_FQDN_MISMATCH=1 to override)"; exit 1.
- `quota_hard_fail` + ChatGPT quota over limit → "Quota blocked; refusing to launch unless QUOTA_HARD_FAIL=0."; exit 1.
- Headless callers (`--skip-boot`, `--execute`) get the `QuotaWarn` text on stderr even when the boot screen is suppressed.

## Adding a new config field

1. Update `wrappers/schemas/host-config-v1.json` with the field.
2. Add it to `wrappers/cdx/internal/config/config.go` (and its `validate()` checks).
3. Have `api/src/services/wrapper-config.ts` populate it.
4. Wire it through the binary wherever it changes behaviour.
5. Bump `wrappers/<engine>/cmd/<engine>/main.go`'s `Version` via `-ldflags`.
6. CI publishes the new binary; existing hosts pick it up via `--update`.
