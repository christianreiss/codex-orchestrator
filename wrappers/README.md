# Wrapper bakery v2

One static Go binary (`cxx`) serves Codex, Claude, and Grok. Enabled hosts install relative
`cdx -> cxx`, `clx -> cxx`, and/or `cgx -> cxx` aliases; explicit invocation is also available
as `cxx codex ...`, `cxx claude ...`, and `cxx grok ...`. Engine configs, auth, locks, and native
CLI state remain separate.

Layout:

- `cxx/` — the single Go module and multicall command.
- `cxx/internal/app/{codex,claude,grok}` — compatibility CLI personas.
- `cxx/internal/grok` — the verified native installer, isolated managed runtime,
  access-only authentication broker, and TOML ownership merge.
- `cxx/internal/{config,fleetconfig,cron,maintenance,ipc,ipv4,layout,log,signing,uninstall,update}` — shared host primitives (signed config load/recovery, the shared cron coordinator, the background maintenance lease).
- `cxx/internal/{agentbus,agentportal,authnotice,claudequota}` — the `cxx agent` bus (relay worker + `cxx-agent` stdio MCP server), the `cxx portal` relay broker, credential-change notices, and the `cxx claude-quota-statusline` command.
- `cxx/internal/remote` — the `cxx remote` process API on machines reached over SSH. No daemon on either side: ssh(1)'s own `ControlMaster` is the reused connection, and job state lives in a directory on the target, so a cursor is a byte offset into a file and a reconnect is a read rather than a re-run.
- `cxx/internal/observability/tracing` — opt-in OpenTelemetry behind the `cxx_otel` build tag.
- `cxx/internal/persona/{codex,claude}` — intentionally different engine lifecycle behavior.
- `cxx/internal/terminalui` — shared terminal layout, semantic states, width handling,
  and sanitization; persona UI adapters supply engine identity and supported data.
- `schemas/host-config-v1.json` — JSON Schema for the per-host config blob.
- `testdata/` — golden baked configs and their detached signatures, asserted
  byte-for-byte by the TypeScript baker test and loaded for real by
  `cxx/internal/config`. See `testdata/README.md`.

Host-wide commands of the one binary (the `cdx`/`clx`/`cgx` aliases select an engine
automatically; `cxx codex ...` / `cxx claude ...` / `cxx grok ...` do so explicitly):

```
cxx --version                 # wrapper version, commit, signing-key status
cxx sync                      # write fleet-managed content for every installed engine
cxx update                    # verify + install the wrapper target, then re-exec into `cxx sync`
cxx cron [install|remove|run [--due]]   # the shared 15-minute maintenance schedule / tick
cxx portal [status|notify|resolve|say|ask|wait|accept|leave]   # agent portal relay (#afk)
cxx agent [list|send|request|wait|reply|message|cancel|call-open|call-join|listen|poll|status|service|worker|mcp]
cxx remote [info|exec|read|write|wait|signal|ps|rm|get|put|push|pull|down]  # default off; signed remote.enabled
cxx claude-quota-statusline   # Claude Code statusLine command that relays quota readings
cxx grok-auth                # internal native token accessor; requires a live private broker
```

Grok uses the official Grok Build CLI, pinned initially to `1.0.46`. `cgx update`
downloads the exact npm platform package for Linux/macOS on amd64/arm64, verifies
its SHA-512 integrity, decodes the sole `package/bin/grok.br` member, and checks the
native version before publishing `~/.cgx/state/grok-bin`. The private copies live
under `~/.cxx/engines/grok`; busy versions remain protected during pruning. No
npm lifecycle scripts or global installation are needed. `CGX_GROK_BIN` can select
an existing executable; the normal fallback is `$GROK_HOME/bin/grok` or `PATH`.

The signed Grok config is `~/.config/codex-orchestrator/cgx.json` (or
`CGX_CONFIG_PATH`). `GROK_HOME` defaults to `~/.grok`. Fleet configuration is a
TOML partial: `models.default`, `models.default_reasoning_effort`, and owned MCP
servers are merged into native `config.toml`. The ownership sidecar stores hashes;
removed fleet paths are pruned only while their values still match the last sync.
Other user settings and subsequent user edits survive.
`cgx sync` consumes the bootstrap documents after the shared client unwraps their
resource envelopes, retaining the config's `owned_paths` for reconciliation.
Normal Grok launches, sync, status, and doctor request the shared background
coordinator so updates, schedule repairs, and version reports continue on Grok-only
hosts. Maintenance commands do not enqueue another coordinator.

`cgx login` accepts subscription OAuth only. Login runs in a temporary home,
uploads the modern credential map to the central account owner, then erases the
temporary refresh token. Managed launches receive access-only `external`
credentials for the official xAI scope and hold a fixed account lease. A private
Unix broker supplies `cxx grok-auth`; the helper never boots another wrapper,
acquires a native auth-file lock, uploads a projection, or writes the native auth
file. Refresh requests carry the generation of the actually issued token, and
must return an advanced successor or an explicit failure within six seconds.
The server owns refresh tokens and ambiguous refresh recovery.

If a fresh login cannot be accepted, secure hosts retain only that unaccepted
login in a protected pending file for at most 24 hours. `cgx login retry` uploads
it explicitly and retries a generation conflict once against the locked head;
cron never uploads it. Acceptance, `cgx logout`, and uninstall erase the pending
file. Insecure hosts erase failed login material immediately and require a fresh
`cgx login`.

Each managed launch has its own protected `GROK_HOME` and `GROK_AUTH_PATH`, so
native reloads cannot switch it to an unwrapped user's credentials. The original
`sessions` directory is shared at its root to preserve native resume and prompt
history. Auth files and MCP credential caches are never linked. Authored rules,
skills, commands, plugins, instructions, and hooks are retained; `GROK_CONFIG`
and `GROK_CONFIG_PATH` overlays are merged before pinning the managed auth scope.
The owned runtime is removed when the native process ends.

Managed Grok processes disable automatic Claude/Cursor MCP imports with the
native compatibility controls. MCP servers explicitly configured in Grok's
`config.toml` or the project remain available, and skills, rules, hooks, and
other compatibility settings retain their values. This prevents an inherited
`clx` server from routing Grok tools as Claude and avoids stale endpoints from
another CLI's configuration. The original Claude/Cursor files and unwrapped
Grok sessions are preserved. BrowserOS and Playwright entries imported from
Claude are also excluded; add them explicitly to Grok configuration when wanted.
Grok 1.0.46's all-server `mcp doctor` checks raw vendor entries even when disabled.
Use `cgx mcp doctor cgx --json` and `cgx mcp doctor cxx-agent --json` to check the
two managed servers; `cgx inspect --json` distinguishes active and disabled
configuration entries. A successful prompt alone does not establish MCP health.

Interactive managed launches supervise a private leader with relay-on-demand.
Automatic reception uses `grok-acp-v1`: a stdio-only, length-prefixed ACP client
checks native identity and queues prompts with `sendNow:false`. A correlated
queue/update event proves admission; `agent_reply` or `agent_receiver_reply`
separately proves completion. The adapter never handles native tool approvals or
injects health-check turns. Explicit `--no-leader` or `--leader-socket` remains
usable and reports automatic reception unavailable. Headless worker deliveries
use a protected prompt file and native JSON output. Native `-r/--resume`,
`-c/--continue`, and `-s/--session-id` keep their meanings; `-s` creates a new session.

Grok has no verified comparable subscription quota windows, so quota comparison
and automatic quota-based switching remain unavailable for Grok. `cgx uninstall`
removes wrapper-owned state and unused private binaries, preserving unwrapped
credentials and native history. It holds an exclusive original-home maintenance
lease and refuses while a managed session or its inherited native child is active.
Shared cron discovers newly enabled engines from
fresh signed host configs and keeps all three aliases/configs in sync.

The release version is `VERSION` in this Makefile and is stamped into the binary
with `-ldflags -X main.Version=...`. Bumping it is the whole release step:
`scripts/deploy.sh` builds, verifies and publishes any `VERSION` the server does
not serve yet, then recreates the api so hosts update.

Build:

```
make all          # local wrappers/bin/cxx
make test         # go test ./... for the unified module
make release      # stage one cxx build per platform under wrappers/bin/release
make publish-release # explicitly publish the staged VERSION to the served store

make cxx-traced   # opt-in OpenTelemetry build -> wrappers/bin/cxx-traced
make test-traced  # vet + test under -tags cxx_otel
make test-terminal # production renderers in real PTYs and redirected output
```

Grok's optional native checks are explicit: run
`CGX_NATIVE_REGISTRY_CANARY=1 go test -run TestGrokRegistryPackagesCanary -v ./internal/grok`
from `wrappers/cxx` to verify all four pinned npm archives, or set
`CXX_GROK_NATIVE_CANARY_AUTH` to a protected access-only projection and
`CXX_GROK_NATIVE_CANARY_WRAPPER` to the freshly built `cxx`, then run
`go test -race -run TestGrokNativeLeaderCanary -v ./internal/agentbus`.
The latter creates a private leader and local auth/receiver stubs, sends one
fixed-text provider prompt, and tests native external renewal without spending a
refresh grant. Normal test runs skip both network checks.

OpenTelemetry is behind the `cxx_otel` build tag, and `all`, `release` and the CI
build/release jobs stay untagged on purpose: the SDK adds ~7.2 MB (+79%) to an
artifact every host re-downloads on each wrapper update. **A binary built without
the tag cannot emit spans, whatever `CXX_OTEL_TRACES_ENABLED` says** — use
`make cxx-traced`. `make test` cannot compile the tagged half, so the tracing
egress guard and span-hygiene tests only run under `make test-traced`.

`publish-release` validates every staged platform before changing the served
store, publishes immutable version directories by atomic rename, then merges
the platform manifests without dropping rollback builds. Override `OUTROOT`
or `PUBLISH_ROOT` only when intentionally staging or publishing elsewhere.

Fresh-install key bootstrap and publication are owned by `bin/install.sh`. For an
isolated build test, pass a generated public key without modifying tracked files:

```
make release PUBLIC_KEY_FILE=/path/to/installation-signing.ed25519.pub
```

See `docs/wrapper-v2-architecture.md`.

For visual review without contacting a fleet or reading credentials:

```
make terminal-preview
bin/terminal-preview -engine codex -scene startup
bin/terminal-preview -engine claude -scene attention
bin/terminal-preview -engine grok -scene startup
python3 scripts/check-terminal-ui.py --binary bin/terminal-preview --output /tmp/cxx-terminal-review
```

Open `/tmp/cxx-terminal-review/index.html` for a standalone review gallery with
engine views and width/scene selectors. The driver uses deterministic sample data
through the production renderers; it is not shipped as a `cxx` subcommand.
The matrix checks all three engines at 20, 39, 40, 48, 64, 80, and 120 columns, plus
`NO_COLOR`, dumb terminals, ASCII locales, explicit minimal mode, and pipes.
ANSI/text captures and a manifest accompany the gallery for regressions.
