# Wrapper bakery v2 — architecture

The v2 bakery replaces the v1 "concatenate-bash-fragments + strtr placeholders"
pipeline with:

1. **Two static Go binaries** (`cdx`, `clx`), one per engine, built per-arch by
   CI and served as static files from `storage/wrapper/v2/bin/`.
   `/wrapper/v2/download` resolves the calling host's platform and streams the
   matching binary; `/wrapper/v2/bin/...` serves any build by explicit path.
2. **A typed, Ed25519-signed JSON config** issued per host by
   `api/src/services/wrapper-config.ts`, signed via
   `api/src/services/wrapper-signing-key.ts` and re-baked on any host mutation.
3. **A ~50-line POSIX `sh` bootstrap transition launcher** built by
   `api/src/services/wrapper-transition.ts` and returned from the legacy
   `/wrapper/download` — the URL date-versioned shell wrappers already update
   through — that fetches the config + binary, verifies SHA256, and execs the
   binary with `--config`.

## Request flow

```
host             orchestrator                          storage
----             ------------                          -------
POSIX transition launcher ─GET /wrapper/v2/config──> /wrapper/v2 route handler
                                     └─ wrapper-config service
                                          (re-bakes if absent)
                                     └─ returns config.json + ETag
                                                                     ┌─ config.json
                                                                     ├─ config.json.sig
                                                                     └─ meta.json
POSIX transition launcher ─GET /wrapper/v2/bin/...──> serves precomputed static binary
binary  ─POST /auth, ...──> existing host API surface (untouched)
```

## Why typed JSON beats bash placeholders

- Schema-validated on both server and binary side.
- Detached Ed25519 signature; binary refuses tampered config.
- Adding a new field touches just the TypeScript baker, the JSON schema, and
  the Go config struct.
- The binary stays the same shape across hosts; only the config differs.

## Where the legacy bakery used to be

| v1 piece                              | v2 replacement                                    |
|---------------------------------------|---------------------------------------------------|
| `bin/cdx` monolith                    | `wrappers/cdx/cmd/cdx/main.go` + Go module        |
| `bin/clx` monolith                    | `wrappers/clx/cmd/clx/main.go` + Go module        |
| Per-engine bash fragment directories  | Go source split across `internal/...`             |
| Bash-templated wrapper bakery         | `api/src/services/wrapper-config.ts`              |
| Bash installer script builder         | `api/src/services/install-token.ts` (v2 emitter)  |
| Bash seed-auth script builder         | seed token route (v2 emitter)                     |
| `__CODEX_HOST_FQDN__` placeholders    | Typed `host.fqdn` field in the signed JSON        |
| Regex-detected wrapper version        | `-ldflags -X main.Version=...` at build time      |
| SHA256 recomputed every download      | Precomputed in `wrapper-bin-registry.ts` per file |

## File layout

```
wrappers/                     # Go workspace
├── cdx/                      # Codex engine binary (own module)
├── clx/                      # Claude engine binary (own module)
├── schemas/host-config-v1.json
├── testdata/                 # round-trip fixtures
└── Makefile

api/src/services/
├── wrapper-config.ts         # composes + signs the per-host JSON
├── wrapper-signing-key.ts    # Ed25519 signing key loader (wrapper_signing_keys table)
├── wrapper-bin-registry.ts   # FS view of storage/wrapper/v2/bin/
├── wrapper-meta.ts           # /wrapper/v2/meta manifest
├── wrapper-download.ts       # /wrapper/v2/download payload
└── wrapper-transition.ts     # legacy POSIX transition launcher

storage/wrapper/v2/
└── bin/<engine>/<os>-<arch>/{manifest.json, v<version>/<engine>}
```

Per-host config is baked on demand by `wrapper-config.ts` whenever the host's
`config_version` advances; the active Ed25519 signing key lives in the
`wrapper_signing_keys` table and is loaded by `wrapper-signing-key.ts`.

## Endpoints

| Method | Path                                              | Notes                                   |
|--------|---------------------------------------------------|-----------------------------------------|
| GET    | `/wrapper/v2/meta`                                | manifest + signing fingerprint          |
| GET    | `/wrapper/v2/config[?sig=1]`                      | signed per-host config or signature     |
| GET    | `/wrapper/v2/download`                            | Go binary for this host's platform      |
| GET    | `/wrapper/v2/manifest/{engine}`                   | per-platform inventory                  |
| GET    | `/wrapper/v2/bin/{engine}/{os}-{arch}/v{ver}/{e}` | static binary (`ETag=sha256`)          |
| GET    | `/wrapper/download`                               | bootstrap transition launcher (legacy)  |
| GET    | `/install/v2/{token}`                             | v2 installer script                     |
| GET    | `/seed/v2/auth/{token}`                           | v2 seed-auth uploader                   |
| POST   | `/seed/v2/auth/{token}`                           | accept seeded auth payload              |

The legacy unversioned routes stay wired so older hosts keep working: `/wrapper`
aliases `/wrapper/v2/meta`, `/install/{token}` and `/seed/auth/{token}` alias
their `/v2/` twins, and `/wrapper/download` is the one that serves the
`wrapper-transition.ts` launcher — the script that writes the v2 config and
execs the new binary.

`api/test/unit/routes/wrapper-v2-doc-endpoints.test.ts` holds this table against
the routes `api/src/routes` registers, so a row that names an endpoint the app
does not serve fails the suite.

## Database additions

`hosts.config_version` — bumped by `wrapper-config.ts` so the binary sees a new
version every time the input changes.

`hosts.config_baked_at` — timestamp of the last bake (informational; not used
for cache invalidation).

`hosts.wrapper_track` — `legacy|v2`.

`wrapper_signing_keys`, `wrapper_v2_binaries` — operator-facing inventory.

## Operator bootstrap

Once per environment:

```
(cd wrappers && make pubkey)       # copies pubkey into the Go embed slots
(cd wrappers && make release)      # cross-compiles all platforms into storage/
```

After that, hitting `/wrapper/v2/meta` with a valid host API key returns the
binary manifest and the bakery is live for any host whose `wrapper_track` is
flipped to `'v2'`.
