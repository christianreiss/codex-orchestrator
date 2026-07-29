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
```

`publish-release` validates every staged platform before changing the served
store, publishes immutable version directories by atomic rename, then merges
the platform manifests without dropping rollback builds. Override `OUTROOT`
or `PUBLISH_ROOT` only when intentionally staging or publishing elsewhere.

Key bootstrap (one-time, per environment):

```
../scripts/wrapper-v2-init-keys.sh
make pubkey       # copy generated pubkey into the Go embed slot
```

See `docs/wrapper-v2-architecture.md` and the parent `CDX-redo.md`.
