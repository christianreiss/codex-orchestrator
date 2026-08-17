# Remediation status — snapshot `6c0866d3`, 2026-08-17

A external review of `6c0866d3` produced a thirteen-phase remediation brief. This
file records what was actually done against it, and — more importantly — what
was **not**, so nothing in this repository reads as remediated when it is not.

Every item below is either **done** (landed, with the gate that proves it) or
**outstanding** (named, with why it did not land). There is no third category.

---

## Done

### Build, supply chain, and secrets

| Finding | Resolution |
|---|---|
| `api/scripts/build.ts` copied `../.env` into `dist/.env` | Removed. `api/test/unit/ops/build-artifact-secrets.test.ts` runs the real build and fails on any dotenv/credential file or any value from the repository `.env` under `dist/`. The leak was live: `api/dist/.env` existed on the build host. |
| Images re-resolved dependencies at build time (`npm install`, synthesized ranges) | The build emits a pruned `dist/package-lock.json` carved from `api/package-lock.json` — exact versions, integrity hashes, all 14 `@node-rs/argon2` platform packages retained. Images install with `npm ci --omit=dev`. |
| Base images floated on tags | Pinned by multi-arch index digest; `scripts/update-base-images.sh` refreshes every pin and checksum in one command. |
| API image ran as root | Fixed unprivileged `10001:10001`. Verified by building under podman. |
| `runner/Dockerfile` ran `npm install -g @anthropic-ai/claude-code … \|\| true` | Exact `CLAUDE_CODE_VERSION` / `CODEX_VERSION`, SHA256 verification of every downloaded archive before unpacking, no `\|\| true`, post-install version assertion. |
| `/health` reported availability from `shutil.which` | `runner/runner_engines.py` resolves each binary and asks it for its version; `RUNNER_REQUIRED_ENGINES` makes the process refuse to start when a required engine is missing or drifted. |
| CI actions floated on tags | All pinned to full commit SHAs. |

### Stubs and dishonest results

| Finding | Resolution |
|---|---|
| `RunnerProxyService.seedCommand` returned `{status:"ok", queued:true}` with no `db` | Collaborators are required constructor dependencies through narrow ports (`SeedTokenStore`, `RunnerTelemetryReader`). The branch is unrepresentable. |
| `RunnerProxyService.run` discarded `updated_auth` while docs promised `applied` | Runs `ensureServedVerification` (`forceLive`, TTL 0) — the same pipeline as the worker and the `/auth` store path, with compare-and-swap promotion and quarantine. Reports `verdict`, `applied`, `probed`, before/after digests. |
| `reachable: false` invented when no probe ran | `EnsureServedVerificationResult.probe` is set only when a runner verdict was actually obtained. Absent `reachable` means "not probed". |
| `RunnerRunRequest` declared five fields that reached nothing | Removed; a body still carrying them returns `422`. |
| Frontend `RunnerRunResult.output` never produced by the service | Removed. |

### Generation controls and stop reasons

| Finding | Resolution |
|---|---|
| `temperature`, `top_p`, `top_k`, `stop_sequences` accepted, forwarded, honored by neither CLI | `api/src/services/transport-capabilities.ts` types what the CLI transport can enforce. Both compat adapters refuse a request supplying an unsupported control with `400 unsupported_generation_control` **before dispatch**, naming every offending field at once. |
| `system` forwarded to a Codex path with nowhere to put it | `enforced` for Claude, `unsupported` for Codex, and refused on the Codex path. |
| `max_tokens` accepted and dropped | Labelled `accepted-unenforceable`: Anthropic's Messages API requires the field, so refusing it would break the official SDK against this surface. It is forwarded, never claimed as honored, and no `max_tokens` stop reason is reported on this transport. |
| `finish_reason: "stop"` and `stop_reason: "end_turn"` hardcoded | Both derive from what the backend actually reported. The CLI reports nothing, so both surface `null` — the protocols' own spelling for "no claim" — instead of asserting a clean completion for output a timeout may have cut short. |

### Engine selection

| Finding | Resolution |
|---|---|
| `POST /mcp` turned an invalid `X-Engine` into Codex | One strict resolver (`api/src/util/engine-resolution.ts`) used by `/auth` and `/mcp`. Conflicting hints are an error; a malformed hint is never Codex. Omitting the engine still means Codex everywhere it did before. |
| `parseEngine` fell back on invalid input | Fallback now applies to absence only. Stored columns read through `engineFromStoredValue`, which degrades rather than throwing. |
| `inferCanonicalEngine` mapped empty/mixed credentials to Codex | Returns `null` when it cannot tell. `engine` is required on `canonicalizeAuthPayload`; `assertCanonicalEngineConsistent` rejects a record whose credentials contradict its engine. |

### Runner input and outbound fetching

| Finding | Resolution |
|---|---|
| DNS resolved for approval, then re-resolved for the connection (rebinding TOCTOU) | `runner/network_policy.py`: one resolution, socket opened to that exact approved address, connected peer re-verified before any bytes are written, original `Host` header and TLS SNI preserved. |
| SSRF denylist missed ranges (e.g. CGNAT `100.64.0.0/10`) | Replaced with an allow rule: only globally routable unicast. IPv4-mapped IPv6 is unwrapped so both spellings of an address answer identically. |
| Data URLs decoded in full before any size check | The encoded length bounds the decoded size and is checked first. |
| No image count, per-image, or aggregate limits | `RUNNER_MAX_IMAGES`, `RUNNER_MAX_IMAGE_BYTES`, `RUNNER_MAX_IMAGE_TOTAL_BYTES`, read once at import; a bad override fails startup. |
| No content validation | PNG/JPEG/GIF/WebP by magic bytes; a declared MIME that contradicts the content is rejected. |
| Unbounded prompt/system/model/timeout | All bounded on `ExecRequest`. |
| Compressed-body cap bypass | `Accept-Encoding: identity`, and one byte is read past the cap so over-size is detected rather than truncated. |
| Redirects | Not followed — each hop would need its own approval. |

### CI

The browser suite existed but no workflow ran it, so it had rotted: a test
asserting the older flat sidebar was failing at `6c0866d3`, untouched. It is
fixed and now runs in CI, along with the portal build and a `public/admin`
artifact-parity check. Wrapper CI gained gofmt, `go test -race`, staticcheck and
govulncheck (Go 1.25.11 → 1.25.13 for five stdlib advisories); runner CI gained
`ruff check`. Turning staticcheck on found one real defect — a `for` loop in the
portal wrapper whose every branch returned (SA4004) — and thirteen dead
declarations, including `peerBinaryCurrent`/`ownName` duplicated in *both*
persona trees.

---

## Outstanding

These are real findings from the brief that this pass did **not** close.

### 1. Provider-backed streaming, tools, embeddings and exact token counts

The compat gateways shell out to a CLI. Callers can no longer *ask* for a
control it cannot honor (see Done, below), but the transport still cannot
stream, round-trip tool calls, serve embeddings, or count tokens exactly. The
brief requires real provider adapters contract-tested against the official
OpenAI and Anthropic SDKs.

Not closed: neither SDK is a dependency here, and the contract tests need live
provider credentials and billable calls. Writing adapters that cannot be run
against a real provider would produce exactly the untested, plausible-looking
code the brief exists to eliminate. `transport-capabilities.ts` is shaped to
take a second transport entry when those adapters land.

### 2. Typed capability registry, generalized

`transport-capabilities.ts` covers generation controls and stop reasons for the
one transport that exists. The brief's §4.5 wants model listings, admin UI
enablement and documentation tables generated from that same registry, with an
invariant proving the Codex and Claude paths cannot silently diverge. Those
projections still have their own hand-maintained sources.

### 3. God-object decomposition

`agent-messaging.ts` (4,226 lines), `agent-portal.ts` (2,470),
`canonical-auth-store.ts` (1,409) and `runner/app.py` (1,633, now reduced by the
image/network extraction) are untouched as structures. The brief requires
characterization tests *before* splitting them, and these own delivery
idempotency, lock ordering, encryption and revocation semantics. This is
multi-day work and is not started; no architecture/complexity budget check has
been added, because adding one that the tree fails on day one is theatre.

### 4. Go wrapper deduplication, frontend refactors, fresh-install activation

Brief §8 (shared engine-neutral packages), §9 (generic artifact workspace, the
~1,100-line authoring page, global API types) and §10 (engine-neutral feature
readiness, with its migration) are not started.

### 5. Passkey recovery

`docs/ADMIN.md` still says an owner who lost all passkeys has no path but manual
`admin_passkeys` row deletion. The brief requires an auditable local recovery
command. Not started.

### 6. Deliberate, documented deviations

- **`ruff format --check` is not a gate.** The repository has never carried a
  ruff config, and adopting the formatter would rewrite ~1,350 lines of
  pre-existing code. That is the owner's style decision, not a lint gate's.
- **staticcheck waives ST1005 and ST1008**, with reasons recorded in
  `wrappers/cxx/staticcheck.conf`. Every other check is on and clean.
- **No compose-based end-to-end matrix** (brief §12). The API `test:db` tier and
  a multi-arch image matrix were not exercised in this pass.

---

## Gates run

```
api:       npm run typecheck | npm run lint | npm test (3147 passed, 160 skipped)
api (db):  test:db:setup | migrate (21 applied) | test:db (595 passed)
frontend:  npm run check | npm run build | npm run build:portal | playwright (26 passed)
runner:    ruff check | pytest (174 passed)
wrappers:  gofmt -l | go vet | make test | make test-traced | go test -race |
           staticcheck | govulncheck
images:    podman build of the API image — runs as 10001, no .env, 34 runtime packages
```

Also run since: the real-MySQL tier (`test:db:setup` + `migrate` + `test:db`) —
21 migrations applied, 54 files / 595 tests passed, including migration
idempotency and the advisory-lock serialization — and podman builds of both the
API and auth-runner images. The runner image was checked end to end: both CLIs
report their pinned versions (`codex 0.144.1 ready`, `claude 2.1.233 ready`),
and with a deliberately drifted `RUNNER_CLAUDE_VERSION` it refuses to start
(`refusing to start -> claude: installed 2.1.233, image was built with 9.9.9`).

Not run: multi-arch (arm64) image builds and a compose-based end-to-end matrix.
