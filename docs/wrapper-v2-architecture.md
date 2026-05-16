# Wrapper bakery v2 — architecture

The v2 bakery replaces the v1 "concatenate-bash-fragments + strtr placeholders"
pipeline with:

1. **Two static Go binaries** (`cdx`, `clx`), one per engine, built per-arch by
   CI and served as static files from `storage/wrapper/v2/bin/`.
2. **A typed, Ed25519-signed JSON config** issued per host by
   `App\Services\Wrapper\V2\ConfigBaker`, pre-baked into
   `storage/wrapper/v2/cache/` and re-baked on any host mutation.
3. **A ~50-line POSIX `sh` bootstrap shim** (the only thing `/wrapper/v2/download`
   returns) that fetches the config + binary, verifies SHA256, and execs the
   binary with `--config`.

## Request flow

```
host             orchestrator                          storage
----             ------------                          -------
sh shim ─GET /wrapper/v2/config──> WrapperV2Controller
                                     └─ BakeCache::getCurrent
                                          (re-bakes if absent)
                                     └─ returns config.json + ETag
                                                                     ┌─ config.json
                                                                     ├─ config.json.sig
                                                                     └─ meta.json
sh shim ─GET /wrapper/v2/bin/...──> serves precomputed static binary
binary  ─POST /auth, /usage, ...──> existing v1 API surface (untouched)
```

## Why typed JSON beats bash placeholders

- Schema-validated on both server and binary side.
- Detached Ed25519 signature; binary refuses tampered config.
- Adding a new field doesn't require editing bash fragments, the bakery, and
  five PHPUnit fixtures — just the struct, the schema, and the baker.
- The binary stays the same shape across hosts; only the config differs.

## Where the legacy bakery used to be

| v1 piece                              | v2 replacement                              |
|---------------------------------------|---------------------------------------------|
| `bin/cdx` (351 KB monolith)           | `wrappers/cdx/cmd/cdx/main.go` + Go module  |
| `bin/clx` (157 KB monolith)           | `wrappers/clx/cmd/clx/main.go` + Go module  |
| `bin/cdx.d/`, `bin/clx.d/` fragments  | Go source split across `internal/...`       |
| `WrapperService::bakedForHost`        | `ConfigBaker::bakeForHost` + `BakeCache`    |
| `InstallerScriptBuilder` (597 lines)  | `InstallerScriptBuilderV2` (~70 lines)      |
| `SeedAuthScriptBuilder` (166 lines)   | `SeedAuthScriptBuilderV2` (~30 lines)       |
| `__CODEX_HOST_FQDN__` placeholders    | Typed `host.fqdn` field in the signed JSON  |
| Regex-detected wrapper version       | `-ldflags -X main.Version=...` at build time |
| SHA256 recomputed every download     | Precomputed in `BinaryRegistry` per file    |

## File layout

```
wrappers/                     # Go workspace
├── cdx/                      # Codex engine binary (own module)
├── clx/                      # Claude engine binary (own module)
├── schemas/host-config-v1.json
├── testdata/                 # round-trip fixtures
└── Makefile

src/Services/Wrapper/V2/
├── ConfigBaker.php           # composes + signs the per-host JSON
├── ConfigSigner.php          # libsodium Ed25519 wrapper
├── BakeCache.php             # FS cache <host_id>/<engine>/<config_version>/
├── BinaryRegistry.php        # FS view of storage/wrapper/v2/bin/
├── BootstrapShimBuilder.php  # ~50-line POSIX shim emitter
├── InstallerScriptBuilderV2.php
└── SeedAuthScriptBuilderV2.php

storage/wrapper/v2/
├── bin/<engine>/<os>-<arch>/v<version>/<engine>
├── cache/<host_id>/<engine>/<config_version>/{config.json,config.json.sig,meta.json}
└── keys/{signing.ed25519,signing.ed25519.pub}
```

## Endpoints

| Method | Path                                              | Notes                                   |
|--------|---------------------------------------------------|-----------------------------------------|
| GET    | `/wrapper/v2/meta`                                | manifest + signing fingerprint          |
| GET    | `/wrapper/v2/config[?sig=1]`                      | signed per-host config or signature     |
| GET    | `/wrapper/v2/download`                            | bootstrap shim for this host            |
| GET    | `/wrapper/v2/manifest/{engine}`                   | per-platform inventory                  |
| GET    | `/wrapper/v2/bin/{engine}/{os}-{arch}/v{ver}/{e}` | static binary (`ETag=sha256`)          |
| GET    | `/install/v2/{token}`                             | v2 installer script                     |
| GET    | `/seed/v2/auth/{token}`                           | v2 seed-auth uploader                   |
| POST   | `/seed/v2/auth/{token}`                           | accept seeded auth payload              |

The legacy unversioned routes (`/wrapper`, `/wrapper/download`, `/install/{token}`,
`/seed/auth/{token}`) continue to serve v1 output until the atomic-swap commit
re-points them to v2 and deletes the v1 controllers in the same commit.

## Database additions

`hosts.config_version` — bumped by `ConfigBaker::bakeForHost` so the binary
sees a new version every time the input changes.

`hosts.config_baked_at` — timestamp of the last bake (informational; not used
for cache invalidation).

`hosts.wrapper_track` — `legacy|v2`. Default stays `'legacy'` until the
cutover commit, which flips the default and backfills existing rows.

`wrapper_signing_keys`, `wrapper_v2_binaries` — operator-facing inventory.

## Operator bootstrap

Once per environment:

```
scripts/wrapper-v2-init-keys.sh    # generates the Ed25519 keypair
(cd wrappers && make pubkey)       # copies pubkey into the Go embed slots
(cd wrappers && make release)      # cross-compiles all platforms into storage/
```

After that, hitting `/wrapper/v2/meta` with a valid host API key returns the
binary manifest and the bakery is live for any host whose `wrapper_track` is
flipped to `'v2'`.
