# cdx Wrapper Interface (Source of Truth)

## Build + Publish
- `cdx` is the Codex persona of the static `cxx` Go binary built from `wrappers/cxx/cmd/cxx`; the installed `cdx` path is a relative `cdx -> cxx` symlink. During legacy self-update migration, a `cdx-<major>.<minor>.<patch>` filename selects the same persona.
- Build locally with `cd wrappers && make cxx`; `cd wrappers && make release` only stages the complete cross-platform matrix under `wrappers/bin/release`.
- Publish that staged matrix explicitly with `cd wrappers && make publish-release`; set `OUTROOT` for an extracted CI release fragment and `PUBLISH_ROOT` for a non-default served store. Publication validates the complete incoming matrix before its first served payload write.
- CI workflow `.github/workflows/wrappers.yml` runs `go vet` + `make test` + the cross-compile matrix on every push.
- New publication writes only `storage/wrapper/v2/bin/cxx/<os>-<arch>/v<version>/cxx`. On compatible old per-engine URLs, exact historical split bytes win when present; otherwise the URL may stream the matching published `cxx` bytes for pre-migration clients.

## Distribution surfaces

| Method | Path | Returns |
|---|---|---|
| GET | `/wrapper/v2/meta` | per-platform manifest + the primary key's `signing_kid` (DB row id) and `signing_fingerprint` (sha256 of the raw Ed25519 public key, lowercase hex) |
| GET | `/wrapper/v2/config[?sig=1]` | signed per-host config JSON (or detached signature) |
| GET | `/wrapper/v2/download` | raw Go binary for the calling host's detected platform |
| GET | `/wrapper/download` | legacy shell-transition launcher that writes v2 config, installs the binary, then execs it |
| GET | `/wrapper/v2/bin/cxx/<os>-<arch>/v<ver>/cxx` | the common binary; ETag = SHA256 |

Config, download, and cron-check calls send `X-Wrapper-Platform: <os>-<arch>`
(`linux-amd64`, `linux-arm64`, `darwin-arm64`, or `darwin-amd64`) so the
orchestrator can bake the matching `binary_url` / SHA256 for this host.

## Per-host config (typed, signed)

The orchestrator's `api/src/services/wrapper-config.ts` produces a JSON blob
matching `wrappers/schemas/host-config-v1.json` and signs it with Ed25519. The
installer and the legacy transition launcher write the result to
`~/.config/codex-orchestrator/cdx.json` (and its detached signature next door).
On startup the Go binary verifies the signature against the public key embedded
at build time, then loads the config. The binary is single-key: it verifies with
that one embedded key and reads only `payload` and `signature` from the response.
When the orchestrator has several signing keys active, `signature`/`.sig` carry
the primary (oldest) key's signature, so adding a key changes nothing here — but
retiring the primary promotes the next key and this binary then rejects every
config it fetches unless it was rebuilt with the new key. Selecting a specific
key's signature (`signatures[]`, `?sig=1&kid=`) is a server capability `cxx` does
not use yet. See “Signing-key rotation” in `docs/wrapper-v2-architecture.md`.
The config:

```jsonc
{
  "schema_version": 1,
  "engine": "codex",
  "issued_at": "...",
  "expires_at": "...", // issued_at + 30 days; enforced on disk load only
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
    "agent_messaging_enabled": false,
    "engines": "codex,claude",
    "engines_list": ["codex", "claude"]
  },
  "engine_options": {
    "silent": false,
    "model_override": "gpt-5.6-terra",
    "reasoning_effort_override": "high",
    "admin_theme_hint": "auto"
  },
  "agent_messaging": {
    "enabled": false,
    "relay_poll_seconds": 25,
    "queued_ttl_seconds": 86400,
    "channel_preview_enabled": false
  },
  "wrapper": {
    "version": "0.7.7",
    "track": "stable",
    "auto_update": true,
    "binary_url": "https://orch.example.com/wrapper/v2/bin/cxx/linux-amd64/v0.7.7/cxx",
    "binary_sha256": "..."
  }
}
```

## Managed AGENTS.md feature guidance

The admin editor and version history store only canonical base Markdown. During
`/agents/retrieve` or bundled startup sync, the server derives the effective
Codex/host feature state and appends at most one
`<!-- cxx:managed-policy:start -->` … `<!-- cxx:managed-policy:end -->` always prefixes the served document with Codex Orchestrator fleet identity, instruction precedence/safety floor, and Hard Stop Lines. The canonical builder/raw base follows, then `<!-- cxx:managed-features:start -->` … `<!-- cxx:managed-features:end -->` carries host capability guidance.
block. Existing orchestrator-owned blocks are replaced so repeated renders are
idempotent.

The fleet-wide `agents_generation_mode` setting (`GET`/`POST
/admin/agents-generation-mode`) decides what the stored document contributes to
that middle, and nothing else: `managed` (default) serves the composed policy
modules plus custom instructions, `manual` serves the stored document verbatim,
and `off` drops the generated modules and keeps only the operator's custom
instructions. No position suppresses the policy prefix or the feature block — a
host at `off` still receives the fleet rules and the live capability guidance,
so `off` means "stop generating prose", not "no AGENTS.md". The mode is applied
when a document is rendered, not when it is stored, so switching it changes what
every host receives on its next retrieve without creating a version, and
switching back restores the module selection exactly. A stored document with no
builder state was hand-written; nothing in it was generated, so `off` serves it
unchanged. `base_sha256` on the retrieve response always describes the base that
was actually rendered.

The block is concise guidance, not state replication. When applicable it makes
the orchestrator MCP authoritative for fleet Skills and requires `skill_list`
before consulting host-local copies for fleet-Skill work. Workflow, create,
update, and delete requests are routed through `skill://skill-manager`; other
manifests and support files use `skill_retrieve` and
`skill://<slug>/<path>`. Higher-level runtime requirements for built-in/system
Skills still take precedence. The same block routes durable memory through the
MCP `shared_memory_*`, `project_memory_*`, and host-local `memory_*` scopes. A
whole-body shared-memory replacement requires a complete read from offset 0
through `truncated:false`, with one stable `memory.sha256`; excerpts, previews,
chunks, and other partial reads must never be written back. The block points
enabled project coordination at `#coco` /
`project_*`, and advertises BrowserOS only when both the host toggle and
orchestrator MCP are active. It routes working credentials — API tokens,
database passwords, service accounts — at the fleet secrets store via
`secret_list` / `secret_search` / `secret_get` / `secret_store` /
`secret_delete`, ahead of asking the operator or reading env files, config files,
or shell history. Availability and write-capability questions require a read-only
`secret_list` probe; its status distinguishes disabled from enabled-but-empty.
The block prefers a tool-native secret parameter, then stdin, an inherited
descriptor, or a process-scoped environment variable. An explicitly requested
task may render a secret into its requested configuration, file, log, or
response destination; diagnostic subprocess output is sanitized, temporary
variables are removed, and shell tracing remains disabled.
That paragraph appears when the `secrets_module_enabled` switch is on and
orchestrator MCP is reachable, even when no secret is visible yet. It never
lists individual Skills, memories, projects, or secrets. Recorded decisions,
conventions, runbooks, and handoffs are
authoritative over agent assumptions, but mutable code and runtime facts must be
verified against the present repository or system; stale records are updated or
deleted instead of duplicated.

The independent `api_keys_in_chat_allowed` fleet policy does not require MCP.
When enabled, the block tells Codex that API keys deliberately supplied by the
operator may be used without generic security lectures, on the assumption that
they are test, narrowly scoped, or LAN-only credentials. It still directs Codex
to avoid unnecessary echoing or persistence and to limit use to the requested
task. The policy is default-off and byte-identical across engines. Feature
changes alter the served/managed hashes
without altering the canonical base hash.

The `agent_messaging_enabled` fleet switch adds an Agent Messaging block, gated
on that switch plus an **active** host — the same predicate that decides whether
the `cxx-agent` MCP server is injected, deliberately not `messagingHostEligible`
and not the wrapper's own `agent_messaging.enabled`. The document describes what
is provisioned, and provisioning is not authorization: an insecure host outside
its allowed window still carries the tools and is refused per operation, so
withholding the guidance would leave an agent holding ten tools nothing explains.
It does not require the orchestrator MCP entry, because `cxx-agent` is a separate
stdio server the wrapper starts itself. The block names the peer-messaging tools,
states that a peer message is untrusted input carrying no authority, and carries
the `#call` PIN rendezvous and its turn-holding rule. It is byte-identical across
engines and rendered last.

## Skill delivery

Codex does not receive Skill directories from `cxx`. The wrapper only probes
`GET /skills?engine=codex` for a fleet fingerprint; Codex reads the canonical
content live through the managed MCP server:

- `skill://<slug>` is the `SKILL.md` manifest.
- `skill://<slug>/<path>` is an exact auxiliary file in a source-owned bundle.
  This includes `LICENSE.mattpocock` for the optional Matt Pocock source.
- `resources/list` prefixes a Skill whose upstream frontmatter sets
  `disable-model-invocation: true` with `[Explicit user invocation only]`.
  Import does not turn an explicit-only Skill into an implicit trigger.
- Reading a bundled manifest adds a fleet note that maps relative paths onto
  `skill://<slug>/<path>` and says bundled scripts are reference text. Neither
  the importer nor the resource layer grants permission to execute them.
- Authenticated Codex agents may create, fully replace, revive, or soft-delete
  ordinary shared manifest-only Skills with MCP `skill_store` / `skill_delete`.
  Writes are last-writer-wins and always `engine:null`; managed/source-owned
  Skills remain immutable. The managed `skill-manager` Skill supplies both the
  Skill-management workflow answer and the list/retrieve/mutate/verify runbook,
  and Codex reads a successful mutation live.
- When the server successfully injects the managed orchestrator MCP into a
  Codex host config, it also appends a `[[skills.config]]` entry with
  `name = "skill-creator"` and `enabled = false`. This suppresses the
  higher-priority built-in local creator so it cannot answer before MCP
  discovery. The rule is omitted when managed MCP is disabled or unavailable,
  and it is never emitted for Claude.

The Matt Pocock source is off by default, so this surface does not imply it is
enabled on a deployment. Once an admin enables it, the source adapter publishes
only the exact upstream plugin allowlist after resolving `main` to an immutable,
fully validated SHA. Turning the source off removes those resources from Codex
immediately while retaining the server's cached last-known-good bundle; ordinary
fleet-authored and code-managed Skills are unaffected.

## Fleet model defaults

`/admin/engines` and `GET/POST /admin/model-defaults/codex` manage the default
Codex CLI model and its model-dependent persistent effort. The endpoint writes
Codex's native top-level `config.toml` keys, `model` and
`model_reasoning_effort`, into the canonical Codex config document; this matches
the official Codex config schema rather than introducing wrapper-only names.
The fleet starts on `gpt-5.6-terra` at its native `medium` effort.

| Models | Persistent efforts | Default effort |
|---|---|---|
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` | `low`, `medium`, `high`, `xhigh` | `medium` |
| `gpt-5.3-codex-spark` | `low`, `medium`, `high`, `xhigh` | `high` |

The GET response's `catalog` is the machine-readable source of truth for these
model/effort pairs. POST accepts strict
`{model, reasoning_effort?: string|null}`; omitted/null effort selects the
model's default and unsupported combinations return 422. Per-host
`model_override` / `reasoning_effort_override` still take precedence when the
server bakes effective `CODEX_HOME/config.toml`.

## CLI surface

| Subcommand | Purpose |
|---|---|
| `run` (default) | One Codex session; the full startup sequence runs first |
| `status` / `--status` | Responsive local + remote `/auth` status summary on stdout. Returned canonical auth can seed/repair the local file but replaces a fresher usable local login only when that exact candidate was definitively rejected and the canonical is verified; an active local logout marker is always rendered as logged out and exits non-zero even when the fleet digest is otherwise valid. Unreadable config/marker state and failed health return a structured non-zero report, and redirects automatically use compact ASCII. |
| `doctor` / `--doctor` | Responsive self-diagnostic (config, paths, CLI, auth, reachability, latency, disk, cron) on stdout; an unreadable signed config is rendered as a blocked diagnostic instead of bypassing the terminal UI |
| `auth-upload` | Stabilize and POST the effective `CODEX_HOME/auth.json` to canonical store. A native file without `last_refresh` receives one content-bound logical generation reused by concurrent processes. If native Codex replaces the file during the request, upload retries once; a second replacement exits non-zero instead of claiming stale success. Only `valid`/`updated` acknowledges the exact candidate; a canonical-win `outdated` response exits non-zero without clearing logout intent or printing success. The authoritative response is applied only if the accepted local generation is still current. |
| `login` | Run upstream login, then upload every successful non-status result with usable auth, even when its bytes match the pre-login file. Logout intent is superseded only after the server accepts the exact auth + marker snapshot. |
| `login status` | Read-only upstream login probe. It never uploads credentials or acknowledges logout intent. |
| `logout` | Wrapper-owned, pre-journaled logout. With no peer session it holds exclusive session + active-child writer leases across native logout; with any peer it records intent and defers native removal until the final session exits. |
| `lane [normal\|spark\|clear] [--persist]` | Inspect the effective quota lane, set a persistent host preference, or clear it back to the inherited default (`/host/lane`). `--persist` is retained as a compatibility no-op; explicit selections always persist. A stored `normal` selects `gpt-5.6-terra`; stored `spark` selects `gpt-5.3-codex-spark` with high effort and reasoning summaries disabled. Clearing the preference preserves the signed fleet/per-host launch model while quota policy falls back to `normal`. An explicit per-run model/profile flag wins. |
| `ls` | Shorthand for `cdx lane spark` |
| `profile <name>` | Forward `--profile <name>` to the upstream `codex` CLI |
| `<profile-name>` | Shorthand for `cdx profile <name>` when `[profiles.<name>]` exists in the synced `config.toml` and the token is not a wrapper-owned or reserved-Codex subcommand |
| `exec -- <cmd...>` | Bypass the startup sequence and run a single Codex command |
| `cxx agent ...` | Shared Agent Messaging control surface: discover addresses; send, request, wait, reply, inspect, or cancel; inspect the relay; and install/remove its per-user service. Message and reply content is accepted only on stdin. |
| `--help` / `-h` / `help` | Passed straight through to a supervised upstream `codex` child without running auth/sync/boot — handles `cdx --help`, `cdx help`, and `cdx <reserved-subcommand> --help`; it skips the managed run lock but the child inherits effective-home session + active-child descriptors until Codex exits; wrapper-only `--minimal`/`--minimal-output` is consumed rather than forwarded as an unsupported Codex flag |
| `--wrapper-help` | Render the wrapper-owned commands and flags without loading config; never intercepts tokens after `--` |
| `resume [<session>] [<prompt>]` | Reopen a previous Codex session through the normal startup lifecycle. With no session id, the upstream picker is shown; `--last` continues the most recent |
| `--resume[=<session>]` | Alias for the `resume` subcommand above — upstream `codex` has no `--resume` flag, so the wrapper re-spells it as `codex resume [session]`; a following option is not consumed as a session id |
| `execute` / `--execute "<prompt>"` | Headless one-shot via `codex exec`; the boot screen is suppressed but auth + resource sync still run. `--execute` is the spelling that carries the prompt; the bare `execute` token dispatches the same path with an empty prompt and its own trailing arguments appended |
| `cron [install\|remove\|run]` / `--cron [install\|remove\|run]` | Forward to the host-wide `cxx cron` coordinator. It owns one optional schedule (`# cxx-managed-cron`, system fallback `/etc/cron.d/cxx-managed`), removes both historical persona schedules, validates each signed config's host/engine membership, and runs each enabled engine tick exactly once. Config wrapper metadata may legitimately differ during rolling refresh and is not a coordinator gate. The first upgraded legacy cron tick migrates itself to the one shared schedule. Privileged system install/remove discovers every actual owner represented in the standard cron spools. A strictly validated spool filename remains authoritative when the static wrapper's Go `os/user` lookup cannot resolve an NSS/SSSD-only account; config-owner/sudo/current/root safeguards remain lookup-validated. The coordinator snapshots each crontab, removes only lines ending in an exact cxx/cdx/clx managed marker, and restores every changed crontab if cross-user or legacy-system cleanup fails; install also removes its new system entry. The Codex tick reports the upstream CLI as a normalized semantic version even when `codex --version` prints a label such as `codex-cli 0.130.0`. Explicit minimal mode stays ASCII throughout. |
| `--version` / `-V` / `--wrapper-version` / `-W` | Print version + commit + embedded pubkey status |
| `update` / `--update` | Self-update now (verifies SHA256 before swapping), then re-exec the freshly installed binary into `sync` so managed content is written by the new code rather than the one being replaced. `cdx update` re-execs into `cdx sync`; `cxx update` re-execs into `cxx sync`, which covers every installed engine. The restart uses one unit of restart depth and the second pass never re-enters `update`. If the exec itself fails, the new binary is installed but content is unsynced and the wrapper says so and exits 1 |
| `sync` | Write fleet-managed `AGENTS.md`, `config.toml`, and the skills fingerprint without launching Codex and without touching the binary. Runs the same lock, FQDN guard, `POST /sync/bootstrap`, decision matrix, skills probe, and peer reconciliation an interactive run performs, then stops before the quota gate and the launch. Always headless: a host with no usable credential fails closed with the reason instead of opening a `codex login` wizard. Exit 0 on success, 1 on a refused host (same reason text as `run`). Self-update is deliberately suppressed here, so a sync can never install and re-exec from inside itself. On an insecure host the run's own auth session still purges credentials on exit, exactly as `run` does |
| `uninstall` / `--uninstall` | Take the effective-`CODEX_HOME` exclusive auth-maintenance lease, remove Codex-local credentials/state, and request engine-scoped server deletion. An authoritative response with Claude remaining removes only `cdx` and retains `cxx`, `clx`, and the shared cron; confirmed last-engine removal deletes both aliases, `cxx`, and the cron. Offline, non-2xx, or malformed responses preserve every shared artifact. Refuses while another cdx auth session is active and on multi-user hosts without sudo. |

Fresh-install binaries embed the installation-specific verification key via
the `PUBLIC_KEY_FILE` build path used by `bin/install.sh`; the tracked fallback
PEM is not edited. A config signed by another installation therefore fails the
same signature check as any other untrusted payload.

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
top-level `model` / `model_reasoning_effort` in effective `CODEX_HOME/config.toml`, so the
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

## Environment variables

Every `CDX_*` / `CLX_*` variable the `cdx` binary reads. The list is enforced
against the wrapper sources by
`api/test/unit/contract/wrapper-env-surface.test.ts`; a knob the binary reads
but this table omits fails the API suite.

| Variable | Effect |
|---|---|
| `CDX_CONFIG_PATH` | Absolute path of the signed host config, ahead of `$XDG_CONFIG_HOME/codex-orchestrator/cdx.json` and the `~/.config/...` default. The detached signature is still read from `<path>.sig` |
| `CDX_CODEX_BIN` | Absolute path of the upstream `codex` CLI, used ahead of the path cache and `PATH`. An inaccessible value is an error, not a fallback |
| `CDX_CODEX_INSTALL_DIR` | Directory that managed Codex CLI installs/updates write `codex` into, instead of `/usr/local/bin` (or the `~/.local/bin` fallback) |
| `CDX_SKIP_BANNER` | `1` forces the compact ASCII boot screen even on a rich interactive terminal |
| `CDX_AUTH_SESSION_HANDOFF` | Internal, wrapper-set: the encoded session + purge-request leases handed to the re-exec'd binary after a self-update. It is consumed and unset on startup; operators do not set it |
| `CLX_CONFIG_PATH` | Peer reconciliation reads the same override as `clx` when deciding where to write the peer's signed `clx.json` |

Other variables affecting a run are engine-level rather than wrapper-owned and
are documented where they apply: `CODEX_HOME`, `CODEX_ALLOW_FQDN_MISMATCH`,
`QUOTA_HARD_FAIL`, `CODEX_ORCH_PEER_SPAWN`, and the usual `NO_COLOR` / `TERM` /
`COLUMNS` presentation variables.

The shared cron coordinator sets `CXX_CRON_COORDINATED` and
`CXX_CRON_ENGINE_ONLY` only on its own persona children to prevent recursive
coordination. They are internal protocol markers; operators must not set them.

## Peer engine reconciliation

The host installer does not rely on runtime peer reconciliation for initial
provisioning. It fetches every requested signed config first, requires identical
wrapper version/SHA metadata, installs one `cxx` plus enabled relative aliases,
and verifies each requested CLI explicitly. It invokes `cxx cron install` and
`cxx cron run --minimal` once each, so dual-engine installs have one schedule
and one coordinated bootstrap. The final `READY` result is fail-closed across
both engines.

After a successful startup sync, `cdx` reads the host `engines_list`. If Claude is
enabled, `cdx` fetches the signed `clx` config from
`/wrapper/v2/config?engine=claude`, verifies its detached signature and
host/engine identity, writes `clx.json{,.sig}`, then verifies the server's fresh
target bytes by SHA while converging the shared `cxx` binary plus `cdx`/`clx`
aliases. A stale peer config target does not block reconciliation. If Claude is disabled, `cdx` performs
local-only Claude cleanup (the `clx` alias/config, managed `~/.clx`/Claude
state, and the npm global Claude Code package when detected) without deleting
the host row; the shared schedule stays in place for Codex. `cdx --cron run`
forwards to the common coordinator unless it is already an engine-only child.
The coordinator verifies signed config host/engine membership, converges `cxx`
plus its relative aliases, and runs Codex then Claude once without recursion.
It does not compare possibly stale per-config wrapper targets. Explicit
minimal mode propagates through coordinated ticks, while unattended cron
remains non-interactive and escape-free through terminal detection.

## Auth generation, logout, and insecure cleanup

`CODEX_HOME` is honoured consistently for Codex-owned auth and configuration;
when it is unset the usual `~/.codex` directory is used. Every native
credential generation gets one stable content digest and `last_refresh`.
Wrapper processes normally hold the auth-file lock only for a short
read/write/CAS. The deliberate exception is a bounded request that can persist
an auth candidate (`/auth` store or `/sync/bootstrap` with `auth_candidate`):
the auth + logout-intent snapshot stays locked through that network boundary so
logout orders wholly before or after server persistence. Every wrapper-launched
Codex child holds a separate shared lease keyed to the effective `CODEX_HOME`
from `Start` through `Wait`; duplicate session + active-child descriptors are
inherited by the native child, including help, so the leases survive wrapper
SIGKILL until Codex itself exits. Destructive or unconditional writers take the
exclusive side before rename/remove/stabilization. An authoritative conditional
write may proceed alongside a native child because it still holds the auth-file
lock and compares the exact pre-request content generation immediately before
the atomic rename. A late startup, status, upload, or runner response is written
only when `auth.json` still matches that request generation. If two
verified canonical responses raced from the same generation, their
`last_refresh` instants converge monotonically: newer wins in either completion
order and older never rolls it back. Distinct payloads at the same instant are
ambiguous on older APIs: the first bytes are preserved, but the invocation
fails closed instead of silently choosing a digest. A bounded local digest
ledger distinguishes those wrapper-written canonical generations from a
native/local write; the native generation wins regardless of clock ordering.
It also binds the latest wrapper-stabilized local digest to logical
`last_refresh`: if the host clock or file mtime moves backwards after canonical
X, a new native Y is stamped strictly after X and remains stable/fresh for an
immediately started or offline process. A
newer usable login wins unless that exact candidate was definitively rejected
and the API explicitly serves an older `verification_state=verified` canonical.
Invalid local JSON is repairable even when its mtime is newer than canonical;
if an active child blocks required repair and no usable local auth remains, the
command fails closed instead of launching unauthenticated.

Canonical Codex auth follows native `AuthDotJson` selection. Explicit
`auth_mode:"apikey"` uses only top-level `OPENAI_API_KEY`; explicit `chatgpt`
or `chatgptAuthTokens` uses `tokens.access_token`. Without a mode, a present
top-level API key wins over ChatGPT tokens. The server persists one normalized
native mode and strips the opposite credential; unsupported modes fail closed.
Legacy nested/auths-only rows and rows verified under the old reversed
precedence are withheld until the background runner verifies and promotes their
normalized replacement. Offline freshness also inspects a selected ChatGPT
access JWT: a known-expired access token is launchable only when native Codex
has a refresh token, while opaque tokens remain bounded by the normal 24-hour
(or secure-host 7-day) cache window.

Explicit `cdx logout` records a nonce-bearing intent marker next to `auth.json`
*before* starting the destructive native command. It takes exclusive session
maintenance and the active-child writer; if any peer session already selected
auth, native logout is skipped and removal is deferred to the last peer exit.
A marker-write failure never launches native logout, and a non-zero native exit
rolls back a new marker only when the original usable generation is unchanged;
partial removal keeps intent. Managed retrieve cannot rehydrate the governed
generation. A distinct later native login is preserved but does not implicitly
clear intent: only server acceptance of the exact auth generation plus the
exact marker bytes observed by the bounded store clears it. `cdx login status`
is read-only. A logout created while an upload is in flight therefore orders
after that store and cannot be erased by its late response.

All config-backed commands and managed runs take a portable shared session
lease keyed to effective `CODEX_HOME`. They remain concurrent. Each API
`host.secure` response updates only that invocation's durable purge request;
`insecure` and `insecure-denied` statuses are authoritative insecure
observations even when the response omits `host`. The latest observation is not
replaced by stale startup metadata during finalization. New shared acquisitions
fail immediately while uninstall/logout maintenance owns the exclusive side;
concurrent insecure requests stay sticky. The last exiting process alone can
obtain the exclusive cleanup lease and purge `auth.json`; an active Codex child
defers cleanup and the request remains for the next last exit. Final cleanup
also services deferred logout on secure hosts, but never deletes a distinct
usable login or clears its marker before server acceptance. The logout marker
survives insecure purge. Native child descriptor inheritance keeps cleanup
blocked even if the supervising wrapper is killed; no process relies on Linux
`/proc` or owner-PID metadata. A raw `codex` started outside cdx cannot
participate in these leases and is the explicit coordination boundary.

## Startup sequence

1. Load the signed config; refuse to proceed if the Ed25519 signature is invalid. `status`/`doctor` use the structured blocked report described above; other commands exit 2 with a concise sanitized error. A config past its `expires_at` (30 days after it was baked) is instead recovered in place: its signature is still valid, so the wrapper refetches with its own `orchestrator.base_url`/`api_key`, persists the replacement, reloads, and reports `signed config had expired; refreshed it from the orchestrator`. Expiry is checked only for the on-disk config, never for freshly fetched bytes, so a skewed host clock cannot refuse its own replacement. When `host.browseros_mcp_enabled=true`, the startup context shows a BrowserOS chip and synced `config.toml` contains the local BrowserOS HTTP MCP server entry.
2. `flock` on `$XDG_RUNTIME_DIR/cdx.lock` (or `/tmp/cdx-<uid>.lock`) to enforce single-instance per host, then run the FQDN guard before any sync (`CODEX_ALLOW_FQDN_MISMATCH=1` is the explicit override). If the lock is held, the wrapper enters sync-paused mode for managed AGENTS/config/skills writes, wrapper/engine updates, and peer reconciliation, and surfaces neutral `SYNC PAUSED` on the boot screen without hiding API/auth/runner health. It is normal contention that needs no operator action; warning colour is reserved for actionable conditions. The pause explanation appears once in SYSTEM; a distinct result/error still receives the normal footer. Auth remains active but follows the full replacement gate: materialize only verified canonical auth, preserve a newer usable local generation, require definitive-rejection authority for an older verified repair, and compare-and-swap against the request generation plus active-child lease. An absent or structurally unusable native auth file suppresses its cached digest and candidate, forcing canonical repair even during a sync-paused run; only the server's insecure-host window policy may block that repair. The explicit `--allow-concurrent-sync` escape hatch allows normal managed writes without the run lock and is visibly announced. The `cdx` lock is independent from `clx.lock`; Codex and Claude sessions must not pause each other's managed sync.
3. Bundle sync (`POST /sync/bootstrap` with `include_auth=true`, `home`, `username`, AGENTS+config digests, and an optional `auth_candidate`) — auth + AGENTS + config in one round-trip. When a candidate is present, its auth/intent transaction remains locked across the bounded bundle request; an already committed same-generation logout omits it, while a distinct login clears old intent only after `auth_stored`/equivalent acceptance. Resource envelopes are unwrapped before local writes, so effective `CODEX_HOME/AGENTS.md` and `CODEX_HOME/config.toml` contain only the served `content` bodies. On 404/405/501 the wrapper falls back to the legacy per-resource pulls (`/auth`, `/agents/retrieve`, `/config/retrieve`). The fallback converges two ways: preserve newer local auth and attempt store; only a validation-shaped 400/422 plus the already-retrieved verified canonical permits older replacement. Transient/security/rate failures preserve local auth, while `runner_updated_auth_invalid` fails closed.
4. Pass the bundle response through the typed decision matrix (`internal/orchestrator/auth_decide.go`). Handles `valid`, `outdated`, `updated`, `unchanged`, `missing`, `upload_required`, `disabled`, `invalid`, `insecure` (opens the in-place approval-pending box, 5 s refresh), `insecure-denied`, `concurrent`, and `offline` (uses cached `auth.json` within 24 h, or 7 d on secure hosts). Approval polling only repaints an interactive, non-dumb stderr with a measured width of at least 40 columns; other contexts fail immediately with Admin → Host Detail guidance instead of hanging or emitting cursor controls. Honours `versions.api_disabled` and `installation_id` mismatch as hard stops. A server `verification_state=failed` (the background runner worker reached ChatGPT and the canonical token did not authenticate) overrides any green digest status: the launch is refused with a re-login message and the boot-screen auth marker turns red. Startup does not wait on live runner verification; `/auth` and `/sync/bootstrap` expose the stored verdict but include canonical credential bytes only when it is `verified`. Pending/failed runner readbacks remain server-side quarantine and cannot be materialized. When ChatGPT quota metadata is available, the boot screen uses provider-duration labels, explicit unknown resets, the host-effective active lane, provider allow/limit flags, snapshot freshness, and a wrapped burn-rate projection. Current quota state can warn/block only for the active lane; projections remain advisory.
4a. Interactive recovery: when credentials failed live verification, or are missing/upload-required with no usable recovery (including a definitively rejected candidate), interactive `cdx run` prompts before launch, runs `codex login` on acceptance, uploads the resulting effective `CODEX_HOME/auth.json` through `/auth command=store`, and re-runs the startup auth check. Launch proceeds only after the server accepts and verifies the new credentials. Non-interactive runs (cron, `--execute`) fail closed instead of opening a login flow. An unsafe runner rotation (`runner_updated_auth_invalid`) is also a hard stop even when the old local bytes still look usable.
   Bootstrap `candidate_credential_rejected:true` marks the exact submitted
   generation unusable even when no replacement exists. It does not authorize
   an overwrite; only `candidate_rejected_definitive:true` together with
   verified canonical bytes can do that.
5. Skills probe (`GET /skills?engine=codex`) — fingerprints the response using the complete bundle digest, so a source-owned support-file change is visible even when `SKILL.md` is unchanged. A successful unchanged probe is green, a changed fingerprint gets the updated marker, and request/cache-write failures warn instead of being presented as healthy. The config marker applies the same checked/updated/failed/skipped contract to the combined AGENTS/config write. When managed MCP was injected, that config also disables the built-in `skill-creator` by exact name. Skills themselves are served via MCP `resource_read skill://<slug>` and support files via `resource_read skill://<slug>/<path>`; on first boot of each wrapper version, the legacy on-disk caches (`~/.agents/skills`, effective `CODEX_HOME/skills`, and effective `CODEX_HOME/prompts`) are pruned so they don't shadow MCP.
6. Wrapper and Codex CLI version reconciliation — normal `cdx` startup updates the wrapper from the server-declared artifact when `versions.auto_update_enabled` is true, re-execs the original argv, then keeps the local Codex CLI on the server's declared target. `latest` is resolved against GitHub before download so current hosts do not redownload on every launch. Update activity uses the compact `↻` / `✓` / `✗` status line for wrapper, Codex, and peer-wrapper installs; it is coloured only on an interactive terminal, stays escape-free with `NO_COLOR`, and uses width-bounded ASCII when redirected, on `TERM=dumb`, or under explicit `--minimal`. The boot summary uses the same policy: non-exact latest/floor targets only show an arrow when the resolved target is newer than the local CLI. Never blocks launch.
6a. `cdx sync` (and the post-`update` re-exec, and the cron tick) runs steps 2–5 and then stops: no quota
   gate, no PreExec, no portal session, no Codex, and — unlike a normal launch — no wrapper self-update in
   step 6, because a sync pass is already the freshly installed binary.
7. Snapshot the content-bound `auth.json` generation; acquire shared session +
   active-child leases; pass duplicate descriptors into upstream `codex`;
   start/wait while forwarding stdio and signals; release only after exit.
   `PreExec` repeats the FQDN guard immediately before launch.
8. Post-exit auth reconciliation: a changed usable generation is stabilized and
   POSTed to `/auth` store, while a removed/unusable generation records logout
   intent. Only `valid`/`updated` acknowledges that exact upload; `outdated`
   means canonical won and leaves any observed logout marker intact. The
   returned canonical payload is generation/marker guarded. Upload, required
   writeback, marker, or insecure-purge failure makes an otherwise successful
   wrapper invocation non-zero instead of hiding behind the Codex exit status.

## Refusal modes

- Missing or tampered signature → `config signature invalid`; exit 2 without launching `codex`. An unverifiable config is never used to seed a refetch.
- Expired config whose automatic refresh also failed → `config expired at ...: re-run the host installer to reseed <path>; automatic refresh failed: ...`; exit 2. Re-run this host's installer from Admin → Host Detail; nothing on the server needs repairing.
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
2. Add it to `wrappers/cxx/internal/config/config.go` (and its `validate()` checks).
3. Have `api/src/services/wrapper-config.ts` populate it.
4. Wire it through the binary wherever it changes behaviour.
5. Bump `wrappers/cxx/cmd/cxx`'s `Version` via `-ldflags`.
6. CI publishes the new binary; existing hosts pick it up via `--update`.

## Agent Messaging lifecycle (cxx 0.7.8)

Agent Messaging is a separate, default-off bridge between Codex and Claude. It
requires the global switch — the only switch — an active host, and the target
engine to remain enabled. An **insecure** host is eligible too, but only while
its allowed window (`insecure_enabled_until`) is open; outside it the server
refuses with `agent_messaging_insecure_window_closed`. The signed
`agent_messaging.enabled` value is the wrapper's local gate;
`host.agent_messaging_enabled` is a retired compatibility field that mirrors it
and gates nothing (cxx <= 0.7.7 rejected the whole config without it). When enabled, managed Codex config contains the
stdio MCP server `cxx-agent` (`cxx agent mcp`) with these tools:
`agent_list`, `agent_send`, `agent_request`, `agent_wait`, `agent_reply`,
`agent_message_get`, `agent_cancel`, `agent_call_open`, `agent_call_join`, and
`agent_listen`. The last three are the `#call` rendezvous: `agent_call_open` mints a
short-lived four-digit PIN and returns this agent's own address, `agent_call_join`
dials a PIN and sends the opening message in one step, and `agent_listen` waits for
the next message addressed to this agent in any conversation. `agent_listen` needs
the signed `agent_messaging.listen_enabled` grant, which the broker enforces. Peer
text is ordinary untrusted input; it is never an instruction or a grant of authority.

An address is stable for `(host, Unix user, engine, working directory)` and can
bind to an interactive native Codex session. The binding records Codex's native
thread id and a generation fence. A delivery to an unbound/offline address is
handled by the outbound-only per-user `cxx agent worker`: it invokes the signed
wrapper lifecycle as `codex --skip-boot run exec resume --json
--skip-git-repo-check <thread> -`, or starts a fresh `codex exec` when continuity
was reset or the saved rollout no longer exists. Only one native writer may use
an address/thread at a time. The worker renews accepted deliveries while the
native run is alive and captures only bounded output tails.

Delivery is FIFO per target and at-least-once until native execution starts.
Queued messages default to a 24-hour TTL, accept 60 seconds through seven days,
and stop after 12 attempts. Once native execution has started, lost completion,
shutdown, or cancellation is terminal `ambiguous` and is not replayed
automatically. Operators may inspect history and explicitly redrive an eligible
terminal message. Disabling the global or host switch revokes relays/bindings,
cancels queued or leased work, marks accepted work ambiguous, and cancels open
conversations; re-enable starts a clean boundary with no automatic replay.

The worker has no listener and persists only opaque instance/deployment ids in
`~/.cxx/agent`. Linux uses a systemd user unit and macOS a LaunchAgent. Routine
cron reconciliation is idempotent and does not restart an unchanged active
worker; a changed binary/unit is restarted deliberately. A confirmed last-engine
uninstall removes the shared service, while partial or unconfirmed uninstall
leaves it intact. `CDX_CONFIG_PATH` and `CLX_CONFIG_PATH` are copied into the
managed service definition when set so non-default signed config paths survive
background startup.

## Agent portal lifecycle (cxx 0.7.7)

When the persistent portal master switch is on, an interactive Codex root run
or a human-started `--execute`/resume registers through
`POST /host/agent-sessions`. Registration uses the wrapper's host API key; the
wrapper retains the short-lived scoped bridge bearer and exposes only a private
Unix-socket path plus session/engine metadata to the Codex child. Inherited
portal capability variables are scrubbed even when registration or broker
startup fails. Cron, auth/preflight, maintenance, and other wrapper-only
invocations do not register. Heartbeats run best-effort while the child is
alive and completion/failure is published after `Wait`; a portal outage never
prevents the local Codex run.

The internal `cxx portal` surface is intentionally narrow:

- `cxx portal status` reports whether this process has an active scoped session.
- `cxx portal notify --summary TEXT` opens the relay before publishing a bounded attention event, so a fast click cannot race the first poll.
- `cxx portal wait --seconds N` long-polls and leases the oldest ordered item without acknowledging it. Ambiguous responses retry with the same claim UUID, so a lost response returns the existing lease instead of waiting for expiry.
- `cxx portal accept --message-id ID --lease-owner OWNER` acknowledges an item only after its tool result reached the root agent; an unacknowledged lease is redelivered. Ambiguous acceptance retries are automatic and preserve the same lease/body.
- `cxx portal say --text TEXT` publishes safe user-facing assistant text.
- `cxx portal ask --question TEXT [--options "a|b"]` creates a first-answer-wins prompt.
- `cxx portal leave` closes the relay and cancels its undelivered work when the local user returns.

Event and terminal publishes retry ambiguous transport/502 results with their
original operation ID and a fresh per-attempt deadline. When the Codex child
exits, cxx immediately closes the relay, broker socket, and child environment
before any post-run updater/auth work. The broker has a fixed operation
allowlist, bounded request bodies, and a `0700` runtime directory with a `0600`
socket. This keeps the portal bridge bearer out of the child environment and
command line; it is not isolation from other processes running as the same Unix
user. The commands expose no PTY,
approval handling, hidden reasoning, or raw tool output. The managed `#afk`
Skill cooperatively keeps the existing root turn polling; the notice it publishes
lands in the portal and is not pushed anywhere. It cannot wake a Codex process or
model turn that has already stopped; `relay_ready` becomes false when fresh
polling ceases.
