# Wrapper bakery v2

Two static Go binaries (`cdx`, `clx`) replace the legacy bash bakery in `bin/cdx.d/`
and `bin/clx.d/`. Each binary is shipped per-arch by the orchestrator and reads a
per-host signed JSON config issued by `src/Services/Wrapper/V2/ConfigBaker.php`.

Layout:

- `cdx/`, `clx/` — Go modules, one per engine. No cross-binary code sharing.
- `schemas/host-config-v1.json` — JSON Schema for the per-host config blob.
- `testdata/` — fixtures consumed by both Go and PHP round-trip tests.

Build:

```
make all          # local development binaries to wrappers/bin/
make test         # go test ./... for both modules
make release      # cross-compile the platform matrix into storage/wrapper/v2/bin
```

Key bootstrap (one-time, per environment):

```
../scripts/wrapper-v2-init-keys.sh
make pubkey       # copy generated pubkey into the Go embed slot
```

See `docs/wrapper-v2-architecture.md` and the parent `CDX-redo.md`.
