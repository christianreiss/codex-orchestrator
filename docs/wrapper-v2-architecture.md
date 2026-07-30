# Wrapper bakery v2 — architecture

The v2 bakery replaces the v1 "concatenate-bash-fragments + strtr placeholders"
pipeline with:

1. **One static Go binary** (`cxx`) built per architecture by CI and served
   from `storage/wrapper/v2/bin/cxx/`. Hosts expose relative `cdx -> cxx` and
   `clx -> cxx` aliases for enabled engines. `argv[0]` selects the compatible
   alias persona; legacy versioned `cdx-<major>.<minor>.<patch>` and
   `clx-<major>.<minor>.<patch>` invocation names remain compatible during
   self-update migration. Direct calls use `cxx codex ...` or `cxx claude ...`.
   `/wrapper/v2/download` resolves the calling host's platform and streams the
   common binary. Historical per-engine artifacts and URLs remain readable so
   pre-migration wrappers can update into the common artifact.
2. **A typed, Ed25519-signed JSON config** issued per host by
   `api/src/services/wrapper-config.ts`, signed via
   `api/src/services/wrapper-signing-key.ts` and re-baked on any host mutation.
3. **A POSIX `sh` bootstrap transition launcher** built by
   `api/src/services/wrapper-transition.ts` and returned from the legacy
   `/wrapper/download` — the URL date-versioned shell wrappers already update
   through. It writes the engine config, verifies SHA256, installs `cxx` plus
   its relative alias, and execs `cxx <engine>` with the original arguments.
   A dual-engine installer fetches both configs first and refuses to install
   unless their wrapper version and SHA256 are identical.
4. **One host-wide update coordinator** (`cxx cron`) validates signed config
   host/engine membership and ticks each enabled persona once. It does not gate
   on per-config wrapper targets, which may differ during rolling refresh. The
   first upgraded legacy cron tick installs `# cxx-managed-cron` (system
   fallback `/etc/cron.d/cxx-managed`) and removes both old persona schedules.
   Privileged reconciliation discovers every actual crontab owner represented
   under `/var/spool/cron`, `/var/spool/cron/crontabs`, `/var/at/tabs`,
   `/var/cron/tabs`, or `/usr/lib/cron/tabs`, then adds resolved config-home
   owner, valid sudo caller, current OS user, and root safeguards. After strict
   lexical validation, a spool filename is authoritative even when the static
   CGO-free wrapper's Go `os/user` lookup cannot resolve an NSS/SSSD-only
   account; the added safeguard identities still require lookup validation.
   It snapshots each discovered crontab, strips only lines ending in an exact
   cxx/cdx/clx managed marker, and leaves all unrelated bytes untouched. A partial
   user-crontab failure or later legacy `/etc/cron.d` cleanup failure restores
   every snapshot and removes the new system entry, so migration fails closed
   instead of committing two jobs.

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
| `bin/cdx` / `bin/clx` monoliths       | `wrappers/cxx/cmd/cxx` + one Go module            |
| Per-engine bash fragment directories  | Shared Go packages plus persona-specific packages |
| Bash-templated wrapper bakery         | `api/src/services/wrapper-config.ts`              |
| Bash installer script builder         | `api/src/services/install-token.ts` (v2 emitter)  |
| Bash seed-auth script builder         | seed token route (v2 emitter)                     |
| `__CODEX_HOST_FQDN__` placeholders    | Typed `host.fqdn` field in the signed JSON        |
| Regex-detected wrapper version        | `-ldflags -X main.Version=...` at build time      |
| SHA256 recomputed every download      | Precomputed in `wrapper-bin-registry.ts` per file |

## File layout

```
wrappers/                     # Go workspace
├── cxx/                      # Common binary and both personas
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
├── bin/cxx/<os>-<arch>/{manifest.json, v<version>/cxx}
└── bin/<engine>/...          # immutable historical cdx/clx artifacts
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
| GET    | `/wrapper/v2/bin/cxx/{os}-{arch}/v{ver}/cxx`      | common static binary (`ETag=sha256`)   |
| GET    | `/wrapper/v2/bin/{engine}/{os}-{arch}/v{ver}/{e}` | exact historical split bytes, else matching `cxx` bytes |
| GET    | `/wrapper/download`                               | bootstrap transition launcher (legacy)  |
| GET    | `/install/v2/{token}`                             | v2 installer script                     |
| GET    | `/seed/v2/auth/{token}`                           | v2 seed-auth uploader                   |
| POST   | `/seed/v2/auth/{token}`                           | accept seeded auth payload              |

The legacy unversioned and per-engine routes stay wired so older hosts keep working: `/wrapper`
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
(cd wrappers && make pubkey)       # copies pubkey into the cxx embed slot
(cd wrappers && make release)      # stages the complete platform matrix
(cd wrappers && make publish-release PUBLISH_ROOT=/path/to/served/wrapper/v2/bin)
```

After that, hitting `/wrapper/v2/meta` with a valid host API key returns the
binary manifest and the bakery is live for any host whose `wrapper_track` is
flipped to `'v2'`.

## cxx rollout and rollback

Build into a staging directory outside the served `bin/cxx` root; a tag's CI
archive is a single-version release fragment, not a replacement store. After
extracting it to a stage root, publish with
`(cd wrappers && make publish-release OUTROOT=/path/to/stage PUBLISH_ROOT=/path/to/served/wrapper/v2/bin)`.
The target validates the complete incoming matrix and all existing rollback
payloads before its first destination write, publishes immutable version
directories by atomic rename, and atomically replaces each platform manifest
while retaining its history. A multi-platform filesystem has no single
cross-directory rename: during those four manifest replacements the common
matrix may briefly be mixed, which the API deliberately treats as fail-closed
while leaving the last-known-good DB pointers alone. It never falls back to
split bytes once `bin/cxx` exists. Restart the API only after all four manifests
have the same `current`, every listed size/SHA256 verifies, and each new
executable has been checked. Then verify both engine compatibility keys resolve
to the same common artifact and migrate one canary before allowing the fleet
cron to proceed.

The host migration is forward-only at the filesystem boundary: after a host
has relative `cdx -> cxx` / `clx -> cxx` aliases, those names cannot safely be
pointed at historical engine-specific bytes. Emergency rollback order is:

1. Disable wrapper auto-update and remove the shared `cxx` schedule on hosts
   selected for rollback.
2. Move the served `bin/cxx` root completely out of `bin/` and restart the API.
   Do not leave an empty or partial `bin/cxx` tree: its presence deliberately
   blocks split fallback. API boot republishes the historical per-engine
   compatibility keys; verify their version, URL, and SHA before touching a
   host.
3. Atomically replace each migrated alias with the matching regular historical
   `cdx` or `clx` binary and restore its legacy schedule. Never point a common
   alias at engine-specific bytes.
4. Only after host paths match the split projections may the application
   commit be reverted or wrapper auto-update be re-enabled.

Keep the immutable `bin/codex` and `bin/claude` trees available until the fleet
migration and rollback window are closed. Editing DB pointers while a complete
`bin/cxx` matrix remains active is ineffective because boot derives and
rewrites those compatibility keys from the published artifact store.
