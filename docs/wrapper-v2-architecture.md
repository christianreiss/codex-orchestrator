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
`config_version` advances; the active Ed25519 signing keys live in the
`wrapper_signing_keys` table and are loaded by `wrapper-signing-key.ts`. More
than one row may be active at a time — see [Signing-key rotation](#signing-key-rotation).

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

## Observability

Both sides of the wrapper stack can emit OpenTelemetry spans, and both are off
by default. The API's toggle is `OTEL_TRACES_ENABLED`; the `cxx` binary's is
`CXX_OTEL_TRACES_ENABLED`, and that prefix is not cosmetic — see
[Wrapper spans (`cxx`)](#wrapper-spans-cxx).

Two things to know before you go looking for traces:

- **The released `cxx` cannot trace.** Its SDK is behind the `cxx_otel` build
  tag and `make release` builds untagged, so `CXX_OTEL_TRACES_ENABLED` on a
  fleet-installed binary does nothing. See
  [Build tag: the released binary has no SDK](#build-tag-the-released-binary-has-no-sdk).
- **The two halves are two separate traces.** No trace context crosses the
  wrapper → API boundary. See
  [Known limitation: no trace context crosses the boundary](#known-limitation-no-trace-context-crosses-the-boundary).

### Bakery spans (API)

The bakery emits OpenTelemetry spans. They are **off by default**, and off means
nothing is loaded: with `OTEL_TRACES_ENABLED` unset, `initTracing` returns before
its first `await import(...)`, so no OpenTelemetry package is imported, no
provider is registered, no exporter exists and no socket is opened.
`withSpan` then calls its callback directly.

Turn it on with two variables (`api/src/env.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_TRACES_ENABLED` | `false` | The only switch. Nothing else can enable tracing. |
| `OTEL_SERVICE_NAME` | `codex-orchestrator-api` | `service.name` on the resource. |

Everything else — where spans go, headers, timeouts, sampling — comes from the
spec-standard `OTEL_EXPORTER_OTLP_*` and `OTEL_TRACES_SAMPLER*` variables, which
the SDK reads itself. The default exporter is OTLP over HTTP
(`http://localhost:4318/v1/traces`) behind a batching processor;
`app.addHook('onClose')` flushes it, so a SIGTERM does not drop the last batch.

Instrumentation is **manual**. `api/scripts/build.ts` bundles and minifies the
server, so the auto-instrumentation packages have nothing recognisable to
monkey-patch. Spans are opened explicitly:

```
GET /wrapper/v2/config          route handler; http.request_id, wrapper.host_id,
└── wrapper.config.bake         wrapper.engine, wrapper.config_version
    ├── wrapper.config.collect  the Promise.all fan-out (documents, skills,
    │                           settings, binary resolution, messaging flag)
    ├── wrapper.config.bump_version   the SELECT … FOR UPDATE + UPDATE
    └── wrapper.config.sign     canonicalStringify + etag + one signature per
                                active key; wrapper.signer_count
```

`bakeForHost` is the root when nothing above it opened a span (the legacy
`/wrapper/download` transition script bakes this way). Both typed exits set span
status `ERROR` and an `error.type` attribute: `WrapperSigningUnavailableError` on
the bake span, `WrapperBinaryUnavailableError` on both `wrapper.config.collect`
(where `wrapperBlock` raises it) and the bake span it propagates through.

`http.request_id` is the same value the request-id plugin echoes as
`x-request-id` and pino stamps on every log line for the request, so a trace and
its logs join on it without a log-correlation exporter.

**No secret ever reaches a span.** Attributes are limited to host id, engine,
schema version, config version and the *count* of active signers. The resolved
`orchestrator.api_key`, any signature value, any key id or fingerprint, and the
canonical JSON bytes are all excluded, and error status carries only the error's
class name — never its message. A span leaves the process for a collector this
repo does not control, so it is a lower-trust sink than a log line;
`test/unit/observability/tracing.test.ts` sweeps every attribute of every
finished span to keep it that way.

The tracing toggle is deliberately **not** part of the baked config payload.
`wrappers/schemas/host-config-v1.json` is `additionalProperties: false` at every
level and the payload is signature-covered, so an observability flag there would
be a wire-contract change for every deployed binary. It is an API-side env var
and nothing else.

The four `@opentelemetry/*` packages are listed twice in `api/scripts/build.ts`:
once in esbuild's `external` array and once in the runtime-dependency allowlist
that produces `dist/package.json`. Both lists must stay in sync — a package in
the first but not the second ships an image with an unresolvable import, and a
`npm run build` that succeeds does not catch it. After changing either list,
check that these two agree:

```sh
grep -o '@opentelemetry/[a-z-]*' dist/server.js | sort -u
grep -o '@opentelemetry/[a-z-]*' dist/package.json | sort -u
```

### Wrapper spans (`cxx`)

The `cxx` binary emits its own spans from
`wrappers/cxx/internal/observability/tracing` — **in a build that was compiled
with `-tags cxx_otel`**. Read the next section first; the default binary, the
one the fleet installs, has no SDK in it at all.

In a traced build, tracing is still off unless `CXX_OTEL_TRACES_ENABLED` is
truthy, and off is total: `tracing.Init` returns before it builds an exporter or
a provider, so no socket is opened, no background goroutine starts, and
`tracing.Start` hands back the caller's context plus a zero-sized no-op span.
The disabled path costs one atomic load.

`Init` is called from `lifecycle.Run` in each persona, not from `main`, so
`cdx cron`, `cdx update`, `clx uninstall` and every other subcommand pay
nothing.

#### Build tag: the released binary has no SDK

The package is one exported API over two implementations in the same directory:

| File | Constraint | Contents |
| --- | --- | --- |
| `tracing.go` | none | Env contract, `Config`/`ConfigFromEnv`, `Attr`, the `Span` interface, `ErrorType`. Imports no OpenTelemetry. |
| `tracing_stub.go` | `//go:build !cxx_otel` | **The default.** `Init` returns a no-op, `Enabled` returns false, `Start` returns the caller's context. Imports no OpenTelemetry. |
| `tracing_otel.go` | `//go:build cxx_otel` | The real exporter, provider and span types. The only file that imports `go.opentelemetry.io`. |

The exported names are identical in both, so no call site branches and neither
persona lifecycle knows which half it was compiled against.

`cxx` is sha256-manifested and self-distributes: every host re-downloads the
whole binary on each wrapper update. Linking the SDK unconditionally cost
**+7.2 MB (+79%)** on `linux/amd64`, already under `-trimpath -ldflags "-s -w"`,
for a feature that is off by default — so the tag is what keeps that off the
fleet. `make cxx`, `make release`, and the `build` and `release` jobs in
`.github/workflows/wrappers.yml` all build **untagged**, deliberately. Do not add
the tag to any of them.

The consequence, which will surprise somebody eventually: **setting
`CXX_OTEL_TRACES_ENABLED` on a fleet-installed `cxx` produces no spans.** The
stub logs one debug line saying the binary was not compiled with tracing, and
that is all. To get spans, build your own:

```sh
cd wrappers && make cxx-traced        # -> wrappers/bin/cxx-traced
# or
cd wrappers/cxx && go build -tags cxx_otel -o /tmp/cxx ./cmd/cxx
```

Two guards keep the default build honest:

- `cmd/cxx/otel_linkage_test.go` (`!cxx_otel`) reads the test binary's own module
  list via `debug.ReadBuildInfo` and fails if any `go.opentelemetry.io/*` module
  is linked. `make test` runs it.
- The authoritative check is on the artifact itself:

  ```sh
  cd wrappers/cxx
  CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tmp/cxx-default ./cmd/cxx
  go version -m /tmp/cxx-default | grep -c opentelemetry   # must be 0
  ```

Because the tag hides the SDK from the *linker* but not from the *module graph*,
`go.mod`, `go.sum` and `go list -m all` (58 modules) look the same either way.
That is expected: build tags prune what is compiled, not what is required.

`make test` and CI's untagged `go vet` do not compile `tracing_otel.go` at all,
so the tracing egress guard and the span-hygiene tests would go unexercised.
`make test-traced` (`go vet -tags cxx_otel` + `go test -tags cxx_otel`) runs
them, and the `test` job in CI invokes it as a separate step.

#### Why the variables are `CXX_`-prefixed

This is the part to read before changing anything here.

`wrappers/cxx/internal/codex/preexec.go` (`exportOTELFromConfig`) calls
`os.Setenv` on `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
`OTEL_SERVICE_NAME`, `OTEL_TRACES_EXPORTER`, `OTEL_RESOURCE_ATTRIBUTES` and
`OTEL_EXPORTER_OTLP_HEADERS` **inside the wrapper's own process**, so the child
Codex CLI inherits the collector the user configured in `~/.codex/config.toml`.
Those headers routinely carry a bearer token.

So inside `cxx`, the standard `OTEL_*` names are someone else's configuration.
A wrapper that read them — directly, or by letting the SDK autoconfigure itself
from the environment — would ship its own spans, and that `Authorization`
header, to a collector the user never pointed at the wrapper. That is data
egress, not a wiring bug. Three things prevent it:

1. The package reads only `CXX_OTEL_*` names, through an injectable `getenv`, so
   the rule is enforced by a test rather than by a convention.
2. Every exporter and provider field the SDK would otherwise take from the
   environment is passed as an explicit option — endpoint URL, headers, TLS,
   compression, timeout, retry, sampler, span limits and batch-processor
   settings. `otlpconfig.NewHTTPConfig` applies env config *before* caller
   options, so an explicit option wins; one that is omitted does not.
3. The exporter and provider are constructed inside `withoutBareOTELEnv`, which
   removes the entire `OTEL_` namespace from the process environment for the
   duration and restores it exactly. This is not belt-and-braces: `WithResource`
   merges `resource.Environment()` unconditionally and offers no option to stop
   it, so `OTEL_RESOURCE_ATTRIBUTES` would otherwise ride out on every span.
   Mutating the environment is safe exactly there, for a call-graph reason
   rather than a short-window one: `Init` is the first statement of `Run`, so no
   goroutine this binary starts is running yet; `lifecycle.Run` is reached at
   most once per process (each persona's `internal/app` main dispatches it from
   mutually exclusive switch arms, and `internal/cron.runEnabledTicks` ticks
   each persona as a **separate child process**, sequentially); `PreExec`
   exports those names later in the same `Run` on the same goroutine and sources
   them from `~/.codex/config.toml`, not from the environment; and
   `agentportal.ScrubEnvironment` swaps only the portal's own variables. The
   scrub also runs under the package's init mutex. If `Run` ever becomes
   reachable twice in one process, this reasoning has to be redone.

`internal/codex/preexec.go` is the only file in the module that may read a bare
`OTEL_*` name. To audit:

```sh
cd wrappers/cxx
grep -rn 'OTEL_' internal cmd --include=*.go | grep -v 'internal/codex/preexec.go'
```

Every remaining hit must be a comment, a `CXX_OTEL_*` name, the scrub prefix in
`tracing.go`, or a test that sets a bare variable in order to prove the wrapper
ignores it. A `os.Getenv("OTEL_…")` anywhere else is a defect.

#### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CXX_OTEL_TRACES_ENABLED` | unset | The only switch. `1`/`true`/`yes`/`on`. An injected exporter cannot enable tracing. |
| `CXX_OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | Full OTLP/HTTP traces URL, path included. |
| `CXX_OTEL_EXPORTER_OTLP_HEADERS` | none | `k=v,k2=v2`, values percent-decoded. |
| `CXX_OTEL_EXPORTER_OTLP_TIMEOUT` | `5000` | Milliseconds for one export attempt. |
| `CXX_OTEL_SERVICE_NAME` | `cxx` | `service.name` on the resource. |

Retries are disabled and the shutdown flush is capped at two seconds: `cdx` is
an interactive wrapper and an unreachable collector must not hold up the user's
shell. `Init` never returns an error to the lifecycle — a misconfigured
collector degrades to "tracing off", logged at debug.

`Init` deliberately does **not** call `otel.SetTracerProvider`. Nothing else in
the binary opens spans, nesting travels through `context.Context` either way,
and leaving the global unset means no dependency can start exporting through
our pipeline by accident.

#### Span tree

Everything below exists twice, once per persona
(`internal/persona/{codex,claude}/lifecycle/`):

```
cxx.lifecycle.run                 wrapper.engine, wrapper.version (resource),
│                                 wrapper.headless, wrapper.minimal,
│                                 wrapper.resumed, wrapper.concurrent,
│                                 wrapper.exit_code
└── cxx.lifecycle.bootstrap       wrapper.concurrent, wrapper.bundle_fallback
    ├── cxx.sync.bootstrap        the live POST /sync/bootstrap;
    │                             wrapper.auth_candidate_offered,
    │                             wrapper.auth_status
    ├── cxx.sync.legacy_fallback  ONLY on the per-resource fallback path
    ├── cxx.apply.claude_artifacts     claude only; wrapper.item_count,
    │   └── cxx.apply.collection       wrapper.updated,
    │                                  wrapper.collection_kind
    └── cxx.apply.claude_skills   claude only; wrapper.item_count,
                                  wrapper.updated
cxx.sync.skills                   sibling of bootstrap; wrapper.skills_changed
```

`cxx.sync.legacy_fallback` is labelled a fallback on purpose. It needs
`isBundleUnsupported` (a 404/501/405 from the bundle endpoint), so against a
current orchestrator it is unreachable. A span appearing there means the host is
talking to an old server — not that the sync was slow.

The Claude appliers are instrumented in `applyCollectionResult`,
`applyClaudeArtifactsResult` and `applyClaudeSkillsResult`, not in the `bool`
wrappers beside them. The bundle path calls only the `*Result` functions; the
wrappers are reached from tests alone, so instrumenting those would have shown
green in the suite and emitted nothing from a shipped binary.

#### No secret reaches a span

Attributes are statuses, counts, booleans and the engine name. Auth payloads,
auth digests, API keys, canonical bytes and error *messages* are all excluded —
`Span.Fail` records only the error's Go type name, in `error.type` and as the
status description. `tracing.Attr` has constructors for `string`, `int` and
`bool` and deliberately none for `[]byte`, `error` or `any`, because those are
how a credential ends up on a span. A span leaves the process for a collector
this repository does not control, so it is a lower-trust sink than a log line.

#### Binary cost

This is the number the build tag exists for. All figures are bytes from

```sh
CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -trimpath -ldflags "-s -w" -o <out> ./cmd/cxx
```

on Go 1.25, comparing this branch's default build and its `-tags cxx_otel` build
against the same command on `main` (which has no tracing at all):

| Platform | `main` | Default build | Delta | `-tags cxx_otel` | Delta vs default |
| --- | --- | --- | --- | --- | --- |
| linux/amd64 | 9,093,304 | 9,109,688 | +16,384 (+0.2%) | 16,285,880 | +7,176,192 (+78.8%) |
| linux/arm64 | 8,388,792 | 8,388,792 | 0 | 15,204,536 | +6,815,744 (+81.2%) |
| darwin/amd64 | 9,275,584 | 9,288,032 | +12,448 (+0.1%) | 16,862,640 | +7,574,608 (+81.6%) |
| darwin/arm64 | 8,596,610 | 8,629,810 | +33,200 (+0.4%) | 15,801,234 | +7,171,424 (+83.1%) |

The `make release` LDFLAGS add a few more bytes of version stamping on top of
every column equally; the deltas are what matter. **The released artifact is the
"Default build" column**: the fleet pays the +0.2%, not the +79%.

`go version -m` on the default build reports 3 dependency modules and zero
`go.opentelemetry.io` entries — identical to `main`. The tagged build reports 23
and 8. Almost all of the difference is `go.opentelemetry.io/proto/otlp` dragging
in `google.golang.org/grpc`, `google.golang.org/protobuf` and `genproto`.

Attribution, measured the same way with three throwaway `main` packages pinned to
the same v1.44.0 versions (linux/amd64):

| Program | Size | Increment |
| --- | --- | --- |
| stdlib only | 1,495,224 | — |
| `+ go.opentelemetry.io/otel/sdk/trace` | 4,432,056 | +2,936,832 (~2.8 MiB) — the SDK alone |
| `+ .../otlptrace/otlptracehttp` | 13,332,664 | +8,900,608 (~8.5 MiB) — the OTLP exporter |

Those isolated increments overstate the in-context cost, because `cxx` already
links `net/http` and `crypto/tls`; that is why the real delta is 7.2 MB rather
than 11.8 MB. Note in particular that the **SDK alone is ~2.8 MiB**, not the
"about 0.6 MB" an earlier draft of this document claimed.

If the exporter's share is ever worth attacking, the lever is the exporter and
not the instrumentation — the `CXX_OTEL_*` contract, the call sites and the tests
are exporter-agnostic. No alternative exporter has been built or measured here,
so this document makes no claim about what one would cost.

#### Known limitation: no trace context crosses the boundary

**The wrapper and the API emit two disconnected traces.** `cxx` does not inject a
W3C `traceparent` header on its outbound orchestrator calls, and the API does not
extract one, so a `cdx` run and the `wrapper.config.bake` it triggers land in a
collector as two unrelated trees, joinable only by host id and wall-clock time.
That removes the main thing distributed tracing offers over the structured pino
logs this repository already has; what is left is per-phase timing within each
process.

This is deliberate, not an oversight. Closing it means injection in four separate
HTTP clients on the wrapper side (`internal/persona/codex/orchestrator`,
`internal/persona/claude/orchestrator`, `internal/agentbus`,
`internal/agentportal`), a propagator and remote-parent extraction on the API
side — across the `initTracing` boundary whose entire design point is that
nothing is imported while tracing is off — and tests for both. It was scoped out
of the change that put the SDK behind a build tag.

If you pick it up: the wrapper-side seam wants a `tracing.Inject(ctx, http.Header)`
in the exported API, no-op in `tracing_stub.go` and `propagation.TraceContext` in
`tracing_otel.go`, so call sites stay build-mode-agnostic like every other entry
point here.
