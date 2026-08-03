# Wrapper bakery v2

One static Go binary (`cxx`) serves both engines. Enabled hosts install relative
`cdx -> cxx` and/or `clx -> cxx` aliases; explicit invocation is also available
as `cxx codex ...` and `cxx claude ...`. Engine configs, auth, locks, and native
CLI state remain separate.

Layout:

- `cxx/` — the single Go module and multicall command.
- `cxx/internal/app/{codex,claude}` — compatibility CLI personas.
- `cxx/internal/{config,cron,ipc,ipv4,layout,log,signing,uninstall,update}` — shared host primitives.
- `cxx/internal/persona/{codex,claude}` — intentionally different engine lifecycle behavior.
- `schemas/host-config-v1.json` — JSON Schema for the per-host config blob.
- `testdata/` — fixtures consumed by both Go and PHP round-trip tests.

Build:

```
make all          # local wrappers/bin/cxx
make test         # go test ./... for the unified module
make release      # stage one cxx build per platform under wrappers/bin/release
make publish-release # explicitly publish the staged VERSION to the served store

make cxx-traced   # opt-in OpenTelemetry build -> wrappers/bin/cxx-traced
make test-traced  # vet + test under -tags cxx_otel
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

Fresh-install key bootstrap and publication are owned by `bin/setup.sh`. For an
isolated build test, pass a generated public key without modifying tracked files:

```
make release PUBLIC_KEY_FILE=/path/to/installation-signing.ed25519.pub
```

See `docs/wrapper-v2-architecture.md`.
