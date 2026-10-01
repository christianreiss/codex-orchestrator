# cgx — Grok Build fleet wrapper

`cgx` is the Grok persona of the shared signed `cxx` binary. Installations may
enable any nonempty subset of Codex, Claude, and Grok. `cdx`, `clx`, and `cgx`
are relative aliases to the same binary; explicit invocation is `cxx grok …`.
The wrapper maintains engine-specific auth, config, versions, locks, and leases.
Grok uses the shared Skills, instruction, MCP, project, memory, secrets, and
messaging surfaces with `engine=grok` / `X-Engine: grok`.

## Native CLI and installation

The supported baseline is official Grok Build **1.0.46**. Linux and macOS on
amd64 and arm64 use exact-version official npm native packages
`@xai-official/grok-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}`. The installer
verifies sha512 `dist.integrity` before extracting only `package/bin/grok.br` and
decoding Brotli. It does not run npm lifecycle scripts. A verified private CLI
lives below `~/.cxx/engines/grok`; updates retain the previous installation.
Grok's native self-updater is disabled for managed processes.

On API startup, the verified four-platform `cxx` matrix publishes the same
wrapper version, Linux checksum, and download URL for all three engines.
Runner health is recorded independently for Grok, so a failure in another
engine does not mark a healthy Grok runner unavailable.

`cgx update` checks for offered wrapper releases through the shared verified
binary updater. Wrappers 0.9.9–0.9.12 have a Grok-only logger panic in that
branch. When Codex or Claude is also installed, use `cxx update` to recover to
0.9.13 or later through that engine. Grok-only hosts should run a newly issued
installer for their existing host. Recovery preserves the host's API key,
enabled engines, and native auth.

`CGX_CONFIG_PATH` selects the signed wrapper JSON config. Native CLI configuration
uses `~/.grok/config.toml`: `[models].default` and
`[models].default_reasoning_effort`, plus `[mcp_servers.cgx]`. The bundled catalog
defaults to `grok-4.6` / `high` with `low`, `medium`, `high`, `xhigh`; `grok-4.5`
supports `low`, `medium`, `high`. Both have a 500,000-token context. This catalog
describes native supported IDs; subscription entitlement still depends on the
provider. Codex lane/profile settings and Claude artifact settings do not apply.

Explicit Grok host provisioning creates these fleet defaults when no Grok
client-config row exists, activating the managed MCP feature context. Concurrent
provisioning and config saves serialize before creating a row; an existing
operator-authored policy is preserved. Reading defaults remains read-only.

## Startup and checks

`cgx` prints the shared startup card before the native UI, with the effective
model/effort, installed and target versions, API/auth/runner health, measured
content-sync outcomes, and the server's fleet sync activity. Actual native
model and effort options override the displayed settings. Grok quota usage is
shown as unavailable, and MCP connectivity remains unknown until probed;
an MCP configuration does not prove a healthy connection. Concurrent content
sync remains visibly paused rather than reporting success.

`status` and `doctor` show the same installation/auth metadata without claiming
that they synchronized skills or config. `--minimal` remains a native option
and also selects compact wrapper output; `status --minimal` and
`doctor --minimal-output` request compact checks. Silent/`--skip-boot` launches
retain banner/footer suppression. The configured terminal theme is respected.

Visible interactive launches use native `--no-alt-screen` so the startup card
remains in terminal scrollback instead of being hidden by the native alternate
screen. Native `--minimal` is passed through unchanged, while `--fullscreen`
still selects the native fullscreen layout within the inline terminal.
Headless and silent launches retain their existing terminal policy. The exit
footer uses the final session/auth outcome after private-runtime cleanup.

## Subscription auth and canonical ownership

Only modern xAI subscription OAuth is supported. `grok login --device-auth`
creates a native scope map in `~/.grok/auth.json`. The selected scope is
`https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`; its credential contains
`auth_mode: "oidc"`, `key`, `refresh_token`, `create_time`, `expires_at`,
`oidc_issuer`, and `oidc_client_id`, with provider identity/profile metadata.
The native root is a scope map: adding `last_refresh` at that root breaks it.
A secure host retains a failed, newly created login seed in
`~/.cgx/state/pending-login.json` (mode `0600`) for at most 24 hours;
`cgx login retry` retries that explicit upload. Acceptance, logout, and uninstall
erase it, and background maintenance never uploads it. Insecure hosts erase
failed login seeds and require another `cgx login`. These seeds are distinct
from canonical refresh credentials and managed access-only sessions.

Legacy `web_login` credentials and metered xAI API keys require replacement with
a modern subscription login.

The encrypted canonical envelope contains `last_refresh`, the complete
`grok_auth` scope map, `grok_scope`, and a derived `auths` bearer entry for
`cli-chat-proxy.grok.com`. Unknown native fields and unselected scopes survive
canonical storage. Runtime projections remove refresh tokens from every scope
and unselected bearer keys; the selected runtime credential uses `external`
mode. Runtime projections and native enrichment are never canonical uploads.

The server owns refresh for managed Grok accounts. A per-account MySQL
connection lock serializes owners; a durable `grok_auth_refresh_state` fence
records intent before the token request. A successful raw response is encrypted
immediately, and the replacement is staged in the auth ledger before static
verification and compare-and-swap promotion. Retryable verification rechecks the
staged replacement, never resends the original refresh token. Ambiguous spends
remain `uncertain`; invalid grants require login. A verified distinct login can
recover the account. OAuth discovery is constrained to `https://auth.x.ai`;
uploaded issuer URLs cannot redirect credentials to another endpoint.

`/auth` returns the access-only envelope with `canonical_generation`,
`access_token_digest`, `expires_at`, and refresh-state metadata.
The shared `host` block includes `grok_last_refresh`, `grok_client_version`,
`grok_client_version_override`, `grok_wrapper_version`, `grok_auth_digest`,
`grok_model_override`, and `grok_reasoning_effort_override`; unknown values are
`null`. Reactive refresh supplies `refresh_if_generation` with the exact active
leased account/session.
An already-advanced head returns its successor; otherwise one owner refreshes
that generation. Pending/ambiguous renewal returns a typed error, never the same
failed generation. Host startup needs 600 seconds of lifetime; runner/gateway
execution needs its timeout plus the native 300-second buffer (maximum 900).

## Isolated managed lifecycle

A managed launch uses a private runtime `GROK_HOME`, auth path, and leader socket.
This isolation is required because the native auth reloader reads
`GROK_HOME/auth.json` directly, even when `GROK_AUTH_PATH` points elsewhere.
Sharing the operator's original home could silently switch managed accounts.

The original home remains the logical account-guard scope. Sessions share the
original **sessions root** so UUID/title resume, `--continue`, transcripts, and
prompt history remain available. Recognized user config, rules, skills, commands,
personas, agents, plugins, and hooks are preserved by an explicit asset allowlist;
auth files, auth locks, and MCP credentials are never shared into the managed
runtime. Fleet hooks live in a real owned hooks directory with user hooks copied
alongside them. Direct credential overrides and metered-key fallbacks are removed
from managed subprocess environments.

Managed runtimes disable Grok's implicit Claude and Cursor MCP imports through
their private config and process environment. This prevents another engine's
fleet headers or obsolete local MCP endpoints from entering Grok. Explicit
Grok and project MCP entries and other compatibility features are preserved;
BrowserOS or Playwright must be configured explicitly for Grok. Native 1.0.46's
all-server `mcp doctor` deliberately inspects vendor imports even when runtime
imports are disabled. Use named checks such as `cgx mcp doctor cgx --json` and
`cgx mcp doctor cxx-agent --json` to check the actual managed servers.

Active runtimes hold the original home's shared session guard. Owned native
children inherit it, so an orphaned leader or TUI still prevents uninstall from
removing local or remote state until those processes exit.

The native external-auth command is internal `cxx grok-auth`. It returns only
`{access_token, expires_in, issuer:"https://auth.x.ai"}` and completes within the
native seven-second timeout. It bypasses normal wrapper sync/lease acquisition
and never takes the native auth-file lock: native refresh already holds it.
The bridge tracks current/previous issued token digests and generations so a
heartbeat's newer fetched head cannot misidentify the bearer actually held by
the native process. `GROK_AUTH_EXPIRED=1` triggers generation-aware renewal.

## Native receiver and worker

Managed interactive sessions have an invocation-owned private leader, started
with `--relay-on-demand --no-auto-update`, and a passive `stdio` ACP receiver.
Frames are a four-byte big-endian length followed by JSON. The receiver binds
the exact native UUID observed through the `SessionStart` hook (`sessionId`),
checks the leader session roster/activity, and queues messages with stable
delivery IDs through `session/prompt` metadata. Queue-state events prove
admission; the prompt RPC's eventual turn-completion response is not admission.
Existing durable acceptance, ambiguous-delivery fencing, generation fencing,
deduplication, and reconnect behavior apply. Admission is not an agent reply.
Explicit unmanaged `--no-leader` or custom socket launches report receiver
unavailability honestly. The receiver never answers native permission requests.

## HTTP inference gateway

The OpenAI-shaped subscription gateway is **`/grok/v1`**, isolated from Codex
`/v1` and Claude `/anthropic/v1`. Engine-scoped `sk-cgx-` client keys are managed
at `/admin/grok/keys`; these are orchestrator gateway keys, not xAI provider keys.
`grok_api_disabled` is the independent administrative gateway switch. The shared `AUTH_RUNNER_URL` must point to the three-engine runner; the gateway and static credential probe use the same configured runner.

Supported endpoints are chat completions, responses, legacy completions, and
model list/retrieve. Embeddings are unsupported. The CLI transport accepts text,
model selection, and system instructions. Streaming, tools, sampling, stop
sequences, output-token caps, and image inputs are rejected with explicit 400
errors. Native `text`, `stopReason`, and optional `usage` are parsed; `end_turn`
maps to `stop`, `max_tokens` to `length`, and `refusal` to `content_filter`.
Responses cut short by the native token limit report `status:incomplete`; cache and reasoning details are returned only when native accounting supplies them. Missing or incomplete usage remains unknown; unavailable subscription quota
does not become a zero-usage or healthy quota display.

## Sources verified 2026-10-01

- Installed native `grok 1.0.46 (2765805b9442) [stable]`, its help, and an isolated
  access-only Grok 4.6 completion validated the execution/JSON contract.
- [Official native CLI source](https://github.com/xai-org/grok-build) provided
  auth, external-helper, leader ACP, home-reloader, model, and hook contracts.
  The inspected public source revision is newer than the installed release;
  live checks are required for the release-specific runtime contract.
- [Official Linux native package](https://www.npmjs.com/package/@xai-official/grok-linux-x64)
  supplies the versioned Brotli binary and sha512 package integrity.
