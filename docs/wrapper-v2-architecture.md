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
├── testdata/                 # golden baked configs + .sig, consumed both sides
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
`config_version` advances; the active Ed25519 signing keys live in the
`wrapper_signing_keys` table and are loaded by `wrapper-signing-key.ts`. More
than one row may be active at a time — see [Signing-key rotation](#signing-key-rotation).

### Golden config fixtures

`wrappers/testdata/` holds three baked configs — `host-codex.json`,
`host-codex-insecure.json`, `host-claude.json` — as the exact signed bytes, each
with its detached `.json.sig`. They are consumed by both sides:
`api/test/unit/contract/wrapper-config-golden.test.ts` bakes them with the clock,
the DB, the binary registry, the installation id and a checked-in TEST-ONLY
Ed25519 seed all frozen, and asserts `BakeResult.canonicalJson` byte-for-byte;
`wrappers/cxx/internal/config/golden_test.go` verifies the signature for real,
loads each file through `config.LoadForEngine`, and compares every decoded field
to a literal. A baked byte cannot move without a fixture diff.

Go decodes neither `documents`, `skills` nor `etag`, and cannot byte-compare a
re-marshal (`encoding/json` emits declaration order; `canonicalStringify` sorts
keys). That asymmetry is asserted rather than assumed: the Go test pins the
fixture's top-level key set to `config.Config`'s json tags plus a named
allowlist of those three.

Regenerate with
`cd api && UPDATE_GOLDEN=1 npx vitest run test/unit/contract/wrapper-config-golden.test.ts`;
never hand-edit a fixture. `expires_at` is `issued_at + WRAPPER_CONFIG_TTL_SECONDS`,
so the TTL constant is part of the fixtures' identity — see
`wrappers/testdata/README.md` for the full determinism contract.

## Endpoints

| Method | Path                                              | Notes                                   |
|--------|---------------------------------------------------|-----------------------------------------|
| GET    | `/wrapper/v2/meta`                                | manifest + primary `signing_kid` and `signing_fingerprint` |
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

`hosts.wrapper_track` — vestigial. Historically `legacy|v2` and defaulting to
`v2`, but the value is unvalidated and nothing acts on it: it gates nothing and
is kept only for compatibility. The per-host gate is `hosts.engines`, enforced by
`assertHostEngineEnabled`. (`wrapper-config.ts` has a wrapper track setting of
the same name, surfaced as `track` in the baked wrapper block; its only
implementation is the no-op settings-loader default, so it is always `stable` —
a different thing that happens to share the word.)

`wrapper_signing_keys`, `wrapper_v2_binaries` — operator-facing inventory.

## Operator bootstrap

Fresh installations use the authoritative bootstrap:

```
bin/setup.sh
```

It generates an environment-local Ed25519 pair, passes the public PEM as
`PUBLIC_KEY_FILE` to `make release` (linker injection; tracked `pubkey.pem`
never changes), publishes the complete platform matrix, imports the private
PEM encrypted, proves signing/read-back, and deletes plaintext. The lower-level
`make release` / `make publish-release` targets remain available for explicit
versioned operator releases and recovery.

After that, hitting `/wrapper/v2/meta` with a valid host API key returns the
binary manifest. The v2 routes gate on the signing key first — none configured
is a 503 `wrapper_v2_unavailable` — and then on the requested engine being listed
in `hosts.engines`, a 403 `engine_disabled` otherwise. `wrapper_track` gates
nothing, so the bakery is live for every host whose engine is enabled.

`bin/setup.sh` imports THE key of an installation and refuses to replace it.
Replacing one is rotation, below.

## Config lifetime and expiry recovery

Every baked config carries `expires_at = issued_at + 30 days`
(`WRAPPER_CONFIG_TTL_SECONDS` in `api/src/services/wrapper-config.ts`). Both
stamps come from one clock read, so the signed lifetime is exactly the TTL and
never a second short of it. `GET /wrapper/v2/config` bakes unconditionally on
every request — there is no stored payload to serve — so the server can never
hand out an already-expired config, and any host that talks to the orchestrator
leaves with a full fresh window. The TTL bounds how long a config that has
fallen out of contact stays usable; expiring is not a routine event.

**Where expiry is enforced.** Only on disk, in
`config.LoadForEngine` (`wrappers/cxx/internal/config/load.go`). The shared
`Config.ValidateForEngine` deliberately does NOT check it: the same validator
runs on bytes just downloaded from `/wrapper/v2/config`, and a host whose clock
runs ahead would then reject every replacement config it fetches — including
the one meant to fix it. `ValidateForEngine` still rejects an `expires_at` that
is not RFC3339, because that is a property of the signed document rather than
of the reader's clock.

**Automatic recovery.** An expired config is not tampering, so
`LoadForEngine` returns a typed `*config.ExpiredError` carrying the parsed
document, and `fleetconfig.LoadOrRecover` refetches with the expired config's
own `orchestrator.base_url` and `api_key`, persists the reply **to the path it
loaded from**, and reloads. That path is not always the engine default:
`--config`, `CDX_CONFIG_PATH` and `CLX_CONFIG_PATH` all reach
`LoadOrRecover`, so it persists through `fleetconfig.PersistTo` rather than
`fleetconfig.Persist`, which resolves `config.DefaultPathForEngine` and is what
the peer installers and the cron coordinator still use.
`cdx`/`clx` startup goes through it and prints `signed config had expired;
refreshed it from the orchestrator` once, so a host heals on its next
invocation. The `cxx cron` coordinator heals along its own route and stays
silent: its seed loader simply accepts an expired-but-signature-valid config —
preferring an unexpired sibling-engine config, falling back to the expired one
— and the authoritative refresh it seeds is what replaces the file.

The long-running helpers (`agentbus`, `agentportal`, the MCP bridge) still load
the config directly and hard-fail on expiry. That is deliberate: they are
spawned by a parent that has already recovered, so they never see an expired
config in practice, and giving each of them its own refetch path would multiply
the number of processes that can talk to `/wrapper/v2/config` on startup.

A host whose clock is more than a full TTL ahead of the orchestrator's calls
even a just-issued config expired. `LoadOrRecover` therefore accepts a
replacement that still reads as expired after it was persisted: having reached
the orchestrator and verified its signature is stronger proof of freshness than
a timestamp compared against a clock that is known-wrong. Refusing it would
hard-fail every invocation with no route back. That acceptance is gated on the
document at the path being byte-for-byte the payload just fetched, so skew stays
distinguishable from a refresh that never landed there — otherwise the branch
would quietly return whatever expired document happened to be on disk and the
host would refetch on every invocation without ever converging. A reload that
fails for any other reason — signature, schema, engine — is still a hard
failure, because that is disk corruption rather than skew.

Security invariant: `ExpiredError.Config` is populated ONLY after the detached
Ed25519 signature verified, so the credentials used to seed the refetch are
always authentic. A config that fails signature verification is an ordinary
hard failure and never reaches the network. Any other load failure — missing
file, wrong engine, bad schema version — is returned unchanged and does not
trigger a refetch.

**When recovery fails** (orchestrator unreachable, host API key revoked, engine
disabled), the wrapper hard-fails with the operator instruction first and the
cause second, because the rendered failure is truncated: `re-run the host
installer to reseed <path>; automatic refresh failed: …`. The procedure is to
re-run this host's installer from Admin → Host Detail, which writes a freshly
signed config and its `.sig`. Nothing on the server needs repairing — the
bakery re-bakes on demand.

**Rollout ordering.** Binaries older than this change enforce expiry inside
`ValidateForEngine` and have no recovery path at all, so a host that expires on
one of them needs a manual installer re-run. A fresh config is always a full
TTL away from expiring, so the normal `wrapper.binary_url` auto-update has ~30
days of margin to carry the fleet onto a binary that can self-heal. Hosts that
are offline for longer than that window are the ones to re-seed by hand.

## Signing-key rotation

**What multi-sign does and does not buy.** A `cxx` binary verifies with the ONE
public key embedded in it at build time. Multi-sign is a server-side capability:
the orchestrator can hold several signing keys and emit a signature for each, so
the replacement key's signature exists and is fetchable *before* the fleet is
rebuilt. It does **not** let you retire the old key before the fleet is rebuilt,
and it does not by itself make a rotation seamless. The binary coupling is still
there; what multi-sign removes is the need to have the new key's signature and
the new binaries appear in the same instant.

The mechanics:

- Any number of rows in `wrapper_signing_keys` may have `active = 1`. Every one
  of them signs the same canonical config bytes.
- The **primary** key is the OLDEST active row (`created_at`, then `id`). Its
  signature is the one served as `signature` in `{payload, signature}`, as the
  default `?sig=1` body, and in `x-signature` — the bytes a deployed binary
  verifies. The ordering is a compatibility invariant, not a detail: promoting a
  newer key hands every host a signature its embedded public key rejects. It is
  pinned by a unit test whose fake DB honours the `orderBy` arguments it is
  given, so flipping `asc` to `desc` in `wrapper-signing-key.ts` fails the suite.
- Extra signatures never enter the payload. `GET /wrapper/v2/config` lists them
  in a top-level `signatures` array *beside* `{payload, signature}`, so no signed
  byte, no `etag`, and nothing in `wrappers/schemas/host-config-v1.json` changes,
  and `payload` and `signature` keep their exact bytes. Deployed binaries ignore
  the new key: `fleetconfig.go` decodes into a struct reading only `payload` and
  `signature`, and nothing in the Go tree sets `DisallowUnknownFields`.
- `?sig=1&kid=<id>` or `?sig=1&fingerprint=<hex>` serves the detached signature
  of one named active key; without a selector it stays the primary's. An unknown
  key is a `404 signing_key_not_found` rather than a fall back to the primary —
  a client that asked for key X and was handed key Y's signature would write a
  `.sig` its own public key cannot verify. A selector without `sig=1` is a `422`:
  the full response body already carries every signature in `signatures`.
- `GET /wrapper/v2/meta` reports the primary key's `signing_kid` (its DB row id)
  and `signing_fingerprint` (sha256 of the raw 32-byte Ed25519 public key,
  lowercase hex). `GET /wrapper/v2/config` returns the fingerprint of whichever
  signature it served in `x-signature-fingerprint`; the `x-signature*` headers
  always describe the served bytes, so a selected `?sig=1` reply never disagrees
  with its own body. The fingerprint, not the row id, is what identifies key
  material across installations.
- The API re-reads the active key set every `SIGNER_CACHE_TTL_MS` (30 s). The
  ops script runs in its own process, so without that bound a key it added would
  not reach the running API until someone restarted it.

**The constraint the runbook cannot design away.** With single-key binaries and
one served `signature`, exactly one population can verify at any instant: while
the old key is primary, only binaries embedding the old key verify; the moment it
is retired, only binaries embedding the new key do. There is no overlap window,
and a host that self-updates onto a new-key binary early fails at startup, since
its on-disk `.sig` came from the old key and a bad signature is a hard failure
with no recovery path (only expiry has one — see above). So steps 3 and 4 below
are **coupled**: they are one maintenance window, not two independently safe
steps. Making them separable requires the client to fetch the signature matching
the key it embeds — which `signatures` / `?sig=1&kid=` now makes possible and
which no shipped `cxx` does yet. That is the follow-up, and until it lands the
honest promise is a *staged*, not a seamless, rotation.

**The installer is not an escape hatch from that window.** The installer and the
legacy transition launcher (`wrapper-transition.ts`) take the `.sig` sidecar from
`signature.value` in the response body — the PRIMARY key's — and never pass a
selector, while the binary they install is whatever is currently published. So
they pair *the published binary* with *the primary key*, which is a repair only
while those two agree: before the new-key binaries are published, or after the
old key is retired. Run inside the step 3→4 window it reproduces the breakage
rather than fixing it. Nothing on the server records which public key a published
binary was built with, so this cannot be resolved server-side; an installer that
knows its target fingerprint can ask for the matching signature with
`?sig=1&fingerprint=<hex>`.

The rotation entry point is `api/src/ops/rotate-signing-key.ts`, built into the
image as `dist/rotate-signing-key.js` beside `dist/setup-signing-key.js`.

1. **Add the new key while the old one keeps signing.** Generate an Ed25519
   pair, then `node rotate-signing-key.js add NEW_PRIVATE.pem NEW_PUBLIC.pem`.
   Both keys now sign; the old key is still primary, so nothing on any host
   changes. This step is genuinely reversible and genuinely zero-impact — it is
   the only one that is. Delete the plaintext private key afterwards.
2. **Verify against the RUNNING API, not the database.** `rotate-signing-key
   list` reads through its own service instance and will print the new key even
   if the API is still serving the old set, so it cannot detect a stale cache.
   Ask the API itself, with a host API key:

   ```sh
   curl -sH "X-API-Key: $HOST_KEY" "$BASE_URL/wrapper/v2/config?engine=codex" \
     | jq -r '.signatures[].fingerprint'
   ```

   The new fingerprint must appear. If it does not within `SIGNER_CACHE_TTL_MS`,
   the API is not serving the key you added — stop and find out why instead of
   continuing on the ops script's green.
3. **Build binaries embedding the new public key.** Build and publish with
   `PUBLIC_KEY_FILE=NEW_PUBLIC.pem` exactly as `bin/setup.sh` does. Do **not**
   let hosts pick them up yet: until the old key is retired those binaries reject
   every config the API serves.
4. **Flip: retire the old key and roll the fleet in one window.**
   `node rotate-signing-key.js retire OLD_KEY_ID` stamps `rotated_at`, clears
   `active`, and the newer key becomes primary — its signature now fills
   `signature`/`.sig`. Retiring the only active key is refused, because that
   leaves the bakery returning `503`. Every host still on an old-key binary now
   fails config verification until it is on the new binary with a freshly fetched
   config. Once the new key is primary, the published binaries and the primary
   key agree again, so re-running the host installer from Admin → Host Detail is
   a valid repair for anything that does not converge on its own — it writes a
   fresh config and a `.sig` from the (now new) primary key alongside a binary
   that embeds it. Before this step it is not: see the note above.

Rollback before step 4 is free: retire the new key instead and the primary never
moved. After step 4 it costs a round trip — `add` re-inserts the old key with a
fresh `created_at`, so it comes back as a secondary signer; retiring the newer
key afterwards is what makes it primary again, and the fleet has to move back
onto old-key binaries with it.

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
