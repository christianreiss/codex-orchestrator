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
| `status` / `--status` | Responsive local + remote `/auth` status summary on stdout. Returned canonical auth can seed/repair the local file but never replaces a fresher local login; unreadable config and failed health return a structured non-zero report, and redirects automatically use compact ASCII. |
| `doctor` / `--doctor` | Responsive self-diagnostic (config, paths, CLI, auth, reachability, latency, disk, cron) on stdout; an unreadable signed config is rendered as a blocked diagnostic instead of bypassing the terminal UI |
| `auth-upload` | POST the local `~/.codex/auth.json` to canonical store. `last_refresh` is backfilled with the current UTC RFC3339 stamp if the file lacks one (legacy `normalize_auth_json_file` parity). |
| `lane [normal\|spark\|clear] [--persist]` | Inspect the effective quota lane, set a persistent host preference, or clear it back to the inherited default (`/host/lane`). `--persist` is retained as a compatibility no-op; explicit selections always persist. A stored `normal` selects `gpt-5.6-terra`; stored `spark` selects `gpt-5.3-codex-spark` with high effort and reasoning summaries disabled. Clearing the preference preserves the signed fleet/per-host launch model while quota policy falls back to `normal`. An explicit per-run model/profile flag wins. |
| `ls` | Shorthand for `cdx lane spark` |
| `profile <name>` | Forward `--profile <name>` to the upstream `codex` CLI |
| `<profile-name>` | Shorthand for `cdx profile <name>` when `[profiles.<name>]` exists in the synced `config.toml` and the token is not a wrapper-owned or reserved-Codex subcommand |
| `exec -- <cmd...>` | Bypass the startup sequence and run a single Codex command |
| `--help` / `-h` / `help` | Passed straight through to the upstream `codex` binary without running auth/sync/boot — handles `cdx --help`, `cdx help`, and `cdx <reserved-subcommand> --help`; wrapper-only `--minimal`/`--minimal-output` is consumed rather than forwarded as an unsupported Codex flag |
| `--wrapper-help` | Render the wrapper-owned commands and flags without loading config; never intercepts tokens after `--` |
| `resume [<session>] [<prompt>]` | Reopen a previous Codex session through the normal startup lifecycle. With no session id, the upstream picker is shown; `--last` continues the most recent |
| `--resume[=<session>]` | Alias for the `resume` subcommand above — upstream `codex` has no `--resume` flag, so the wrapper re-spells it as `codex resume [session]`; a following option is not consumed as a session id |
| `--execute "<prompt>"` | Headless one-shot via `codex exec`; the boot screen is suppressed but auth + resource sync still run |
| `--cron [install\|remove\|run]` | Manage the optional host auto-update crontab entry (`run` is the action fired by cron itself); reports the upstream Codex CLI as a normalized semantic version even when `codex --version` prints a label such as `codex-cli 0.130.0`; cron ticks bootstrap `/usr/local/bin` into `PATH` before probing/updating Codex and, on dual-engine hosts, force one guarded `clx --cron run` peer tick so Claude Code is refreshed too. Explicit minimal mode stays ASCII through cron status and peer update output. |
| `--version` / `-V` / `--wrapper-version` / `-W` | Print version + commit + embedded pubkey status |
| `--update` | Self-update now (verifies SHA256 before swapping) |
| `--uninstall` | Remove auth + local state + cron entry; refuses on multi-user hosts without sudo |

### Terminal presentation

Interactive terminals at least 40 columns wide receive the responsive CDX card:
outcome and context first, versions and health next, then quota/activity and the
result. Status is never colour-only (`✓`, `!`, `×`, and update arrows remain
meaningful with `NO_COLOR`). Redirects, dumb/narrow terminals, and `--minimal`
use deterministic ASCII and include local-to-target versions. Dynamic API and
error text is control-sequence stripped and width-bounded. Boot/status result
text is capped at three rendered lines; narrow update rows retain the outcome
before less important version metadata. Explicit `--minimal`
applies consistently to wrapper help, status, doctor, cron/peer-update output,
startup, and the exit footer rather than depending on terminal auto-detection.
For upstream help passthrough, the wrapper consumes that presentation flag and
executes Codex with only its supported help argv.

The context model/effort first reflects an explicit launch model/profile and
the signed/host overrides. Any field still absent falls back to the parsed
top-level `model` / `model_reasoning_effort` in `~/.codex/config.toml`, so the
card does not hide the effective local default. `cdx doctor` parses real TOML
and inspects the parsed managed MCP table (`mcp_servers.cdx` or the legacy
`mcp_servers.codex-orchestrator`); matching text in malformed TOML is not green.

Quota rows derive their window labels from the provider's `limit_seconds`
(`5h`, `weekly`, or the corresponding day/hour/minute duration), preserve a
real `0%` reading, and make warning/block copy say `reset unknown` when the
provider supplies no reset.
Forecast text wraps onto a continuation line instead of being clipped. A
forecast that approaches or crosses the configured threshold raises an
advisory attention outcome but is not current exhaustion and never hard-blocks
by itself. Projection starts only after at least five minutes and 1% of that
quota window have elapsed. The active lane is the host preference
first and the response's
`active_quota_lane` second; only that lane's percentage or provider
`rate_allowed` / `rate_limit_reached` flags affect launch policy. The inactive
lane remains visible as context. Unavailable/error telemetry, malformed fetch
timestamps, and snapshots older than 30 minutes render as warnings. Those
untrusted readings are labelled as last-known context, suppress forecasts, and
cannot warn or block from their stored percentages or provider flags. A Codex
response with no readable snapshot carries `chatgpt.status="unavailable"`, so
absence is visible as unknown health instead of being treated as a green check.

A non-null persisted lane affects execution as well as quota selection and display:
`normal` prepends `--model gpt-5.6-terra`; `spark` selects
`gpt-5.3-codex-spark` with `model_reasoning_effort=high` and
`model_reasoning_summary=none`. Explicit `--model`/`-m` or `--profile`/`-p`
arguments suppress lane injection and are shown as the effective launch choice.
Clearing the stored lane preserves the signed fleet/per-host model; the
effective quota lane still falls back to `normal` for policy and display.

Health markers are evidence-based: a successful unchanged resource check is
green, an actual local write adds the updated marker, a failed best-effort
skills/config check warns, and an unperformed check is dim. Resource-sync
failure remains non-fatal but changes the overall result to attention.
Likewise, stored runner transport failure is attention because auth retrieve
and cached launch remain allowed; only an explicit stored credential-
verification failure blocks the launch.

When `/sync/bootstrap` supplies its compatibility `sessions` object, the
`ACTIVITY` section labels it truthfully: `local procs` is the same-UID `cdx`
wrapper process count; `hosts 30m` is the number of distinct hosts with an
`agents.retrieve` event in the prior 30 minutes; `syncs UTC day` and `syncs UTC
month` are those event totals from the UTC day/month boundaries. They are not
launch or concurrency counts. Older servers omit the block cleanly rather than
producing invented zeroes.

The post-run footer is measured rather than optimistic: real engine exit code,
duration, engine version, and auth-upload outcome drive its overall tone. A
successful engine process with a failed canonical credential upload is shown as
`EXIT 0 · AUTH FAILED`, not green. `--minimal` keeps this footer compact.

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
Interactive peer-install progress inherits `--minimal`; explicit minimal mode
also propagates through cron peer reconciliation, while unattended cron remains
non-interactive and escape-free through terminal detection.

## Startup sequence

1. Load the signed config; refuse to proceed if the Ed25519 signature is invalid. `status`/`doctor` use the structured blocked report described above; other commands exit 2 with a concise sanitized error. When `host.browseros_mcp_enabled=true`, the startup context shows a BrowserOS chip and synced `config.toml` contains the local BrowserOS HTTP MCP server entry.
2. `flock` on `$XDG_RUNTIME_DIR/cdx.lock` (or `/tmp/cdx-<uid>.lock`) to enforce single-instance per host, then run the FQDN guard before any sync (`CODEX_ALLOW_FQDN_MISMATCH=1` is the explicit override). If the lock is held, the wrapper enters sync-paused mode for managed AGENTS/config/skills writes, wrapper/engine updates, and peer reconciliation, and surfaces `SYNC PAUSED` on the boot screen without hiding API/auth/runner health. Auth is the exception: every run still submits the local auth digest and atomically writes server-returned canonical auth when the response is `outdated`/`updated`/`missing`, so a secondary run does not launch with stale local credentials. The explicit `--allow-concurrent-sync` escape hatch allows normal writes without the lock and is visibly announced. The `cdx` lock is independent from `clx.lock`; Codex and Claude sessions must not pause each other's managed sync.
3. Bundle sync (`POST /sync/bootstrap` with `include_auth=true`, `home`, `username`, AGENTS+config digests, and an optional `auth_candidate`) — auth + AGENTS + config in one round-trip. Resource envelopes are unwrapped before local writes, so `~/.codex/AGENTS.md` and `~/.codex/config.toml` contain only the served `content` bodies. On 404/501 the wrapper falls back to the legacy per-resource pulls (`/auth`, `/agents/retrieve`, `/config/retrieve`).
4. Pass the bundle response through the typed decision matrix (`internal/orchestrator/auth_decide.go`). Handles `valid`, `outdated`, `updated`, `unchanged`, `missing`, `upload_required`, `disabled`, `invalid`, `insecure` (opens the in-place approval-pending box, 5 s refresh), `insecure-denied`, `concurrent`, and `offline` (uses cached `auth.json` within 24 h, or 7 d on secure hosts). Approval polling only repaints an interactive, non-dumb stderr with a measured width of at least 40 columns; other contexts fail immediately with Admin → Host Detail guidance instead of hanging or emitting cursor controls. Honours `versions.api_disabled` and `installation_id` mismatch as hard stops. A server `verification_state=failed` (the background runner worker reached ChatGPT and the canonical token did not authenticate) overrides any green digest status: the launch is refused with a re-login message and the boot-screen auth marker turns red. Startup does not wait on live runner verification; `/auth` and `/sync/bootstrap` report the latest stored worker verdict. When ChatGPT quota metadata is available, the boot screen uses provider-duration labels, explicit unknown resets, the host-effective active lane, provider allow/limit flags, snapshot freshness, and a wrapped burn-rate projection. Current quota state can warn/block only for the active lane; projections remain advisory.
4a. Interactive recovery: when the credentials failed live verification, or are missing/upload-required with no usable local file (or the server rejected the candidate), interactive `cdx run` prompts before launch, runs `codex login` on acceptance, uploads the resulting `~/.codex/auth.json` through `/auth command=store`, and re-runs the startup auth check. Launch proceeds only after the server accepts and verifies the new credentials. Non-interactive runs (cron, `--execute`) fail closed instead of opening a login flow.
5. Skills probe (`GET /skills?engine=codex`) — fingerprints the response. A successful unchanged probe is green, a changed fingerprint gets the updated marker, and request/cache-write failures warn instead of being presented as healthy. The config marker applies the same checked/updated/failed/skipped contract to the combined AGENTS/config write. Skills themselves are served via MCP `resource_read skill://<slug>`; on first boot of each wrapper version, the legacy on-disk caches (`~/.agents/skills`, `~/.codex/skills`, `~/.codex/prompts`) are pruned so they don't shadow MCP.
6. Wrapper and Codex CLI version reconciliation — normal `cdx` startup updates the wrapper from the server-declared artifact when `versions.auto_update_enabled` is true, re-execs the original argv, then keeps the local Codex CLI on the server's declared target. `latest` is resolved against GitHub before download so current hosts do not redownload on every launch. Update activity uses the compact `↻` / `✓` / `✗` status line for wrapper, Codex, and peer-wrapper installs; it is coloured only on an interactive terminal, stays escape-free with `NO_COLOR`, and uses width-bounded ASCII when redirected, on `TERM=dumb`, or under explicit `--minimal`. The boot summary uses the same policy: non-exact latest/floor targets only show an arrow when the resolved target is newer than the local CLI. Never blocks launch.
7. Snapshot `auth.json` sha256 + `last_refresh`; `exec` the upstream `codex` CLI; forward stdio + signals. `PreExec` repeats the FQDN guard immediately before launch.
8. Post-exit auth re-upload: if either the sha or `last_refresh` changed during the run (token rotation, `codex login`), POST the new payload to `/auth` store.

## Refusal modes

- Missing or tampered signature → `config signature invalid`; exit 2 without launching `codex`.
- Unreadable signed config during `status`/`doctor` → structured blocked report
  with sanitized, bounded path/cause text; exit 1. Other commands print a
  concise sanitized config failure and exit 2.
- `schema_version != 1` → `unsupported schema_version`; exit 2.
- `engine != "codex"` → `engine "..." not supported by this binary`; exit 2.
- Lock held by another PID with invalid local auth → "Active cdx run detected and local auth.json is invalid or absent."; exit 1.
- `versions.api_disabled=true` → "Auth API disabled by administrator."; exit 1.
- API kill-switch (`versions.api_disabled=true`) blocks startup before auth/config writes.
- `installation_id` mismatch → "Installation ID mismatch; refusing to sync."; exit 1.
- Reverse DNS mismatches are reported from `/auth` as a host/IP policy denial so operators can fix DNS instead of rotating credentials.
- Static IP-binding mismatch (`ip_mismatch`) from `/sync/bootstrap` is a hard policy denial, not an API outage. `cdx` says the current IP is not bound and directs operators to **Admin → Host Detail → Release IP binding** for the controlled IP move; it never launches from cached auth for this condition.
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
