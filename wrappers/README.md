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
- `testdata/` — golden baked configs and their detached signatures, asserted
  byte-for-byte by the TypeScript baker test and loaded for real by
  `cxx/internal/config`. See `testdata/README.md`.

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

Fresh-install key bootstrap and publication are owned by `bin/setup.sh`. For an
isolated build test, pass a generated public key without modifying tracked files:

```
make release PUBLIC_KEY_FILE=/path/to/installation-signing.ed25519.pub
```

See `docs/wrapper-v2-architecture.md`.
