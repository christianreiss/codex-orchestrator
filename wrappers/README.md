# Wrapper bakery v2

One static Go binary (`cxx`) serves both engines. Enabled hosts install relative
`cdx -> cxx` and/or `clx -> cxx` aliases; explicit invocation is also available
as `cxx codex ...` and `cxx claude ...`. Engine configs, auth, locks, and native
CLI state remain separate.

Layout:

- `cxx/` — the single Go module and multicall command.
- `cxx/internal/app/{codex,claude}` — compatibility CLI personas.
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

Host-wide commands of the one binary (the `cdx`/`clx` aliases select an engine
automatically; `cxx codex ...` / `cxx claude ...` do so explicitly):

```
cxx --version                 # wrapper version, commit, signing-key status
cxx sync                      # write fleet-managed content for every installed engine
cxx update                    # verify + install the wrapper target, then re-exec into `cxx sync`
cxx cron [install|remove|run [--due]]   # the shared 15-minute maintenance schedule / tick
cxx portal [status|notify|resolve|say|ask|wait|accept|leave]   # agent portal relay (#afk)
cxx agent [list|send|request|wait|reply|message|cancel|call-open|call-join|listen|poll|status|service|worker|mcp]
cxx remote [info|exec|read|write|wait|signal|ps|rm|get|put|push|pull|down]  # default off; signed remote.enabled
cxx claude-quota-statusline   # Claude Code statusLine command that relays quota readings
```

The release version is `VERSION` in this Makefile (currently 0.8.4) and is
stamped into the binary with `-ldflags -X main.Version=...`.

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
python3 scripts/check-terminal-ui.py --binary bin/terminal-preview --output /tmp/cxx-terminal-review
```

Open `/tmp/cxx-terminal-review/index.html` for a standalone review gallery with
engine pairs and width/scene selectors. The driver uses deterministic sample data
through the production renderers; it is not shipped as a `cxx` subcommand.
The matrix checks both engines at 20, 39, 40, 48, 64, 80, and 120 columns, plus
`NO_COLOR`, dumb terminals, ASCII locales, explicit minimal mode, and pipes.
ANSI/text captures and a manifest accompany the gallery for regressions.
