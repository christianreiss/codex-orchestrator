# cxx wrapper review — 2026-10-26

Release: **0.9.138**. Review started 2026-10-26; completion and rollout 2026-10-27.
Starting point: `0a9775d4863113c87b93fb51e060779b3e773e87`.
Scope: shared `cxx`, multicall `cdx`/`clx`/`cgx`, native dispatch, engine
lifecycles, HTTP/communicator transport, auth/account ownership, signed config,
updates/installers, locks/process lifetime, content ownership, cleanup, cron,
terminal output, tests and release/deployment machinery.

The starting tree contains about 86,000 production Go lines. This review combines
repository-wide inventory and automated checks with focused source inspection of
the risk-bearing paths. The findings below have concrete reproductions or direct
contract violations. Automated coverage and cross-compilation are distinguished
from real provider sessions and execution on other operating systems.

## Fixed findings

| Finding | Before | After / regression evidence |
| --- | --- | --- |
| Credential and body disclosure through redirects | Persona, portal, relay, resident policy and MCP clients could follow default HTTP redirects. Custom host keys and 307/308 auth bodies could reach a foreign origin. | One shared origin policy rejects the foreign hop before transmission. Persona tests cover Codex and the Claude adapter used by both Claude and Grok; portal and relay have integration tests. Same-origin redirects retain valid auth/body behavior. |
| Initial update request trusted hostname alone | An HTTP target on the same host could receive a key belonging to an HTTPS orchestrator. | Scheme, hostname and effective port must match. Public CDN redirects strip key, Authorization and cookies; an intervening foreign hop cannot restore them. HTTPS downgrade is refused. Signed checksums still gate execution/install. |
| Negative retry panic | Claude's retry loop could return `(nil, nil)` for a negative count; JSON then dereferenced the nil response. Grok uses that client. | Shared executor clamps counts to 0–5. All three persona paths prove one attempt for a negative count. Existing caller retry counts and operation IDs are preserved. |
| Unbounded/repeated request buffering and error draining | Each retry reread/rebuffered the original body, failed to close its original reader, and Codex drained an unlimited 5xx response. | Reuse `GetBody`, bound fallback buffering, close the original body and each failed response, read only 2 KiB of error diagnostics, and cancel backoff. Both replay paths and final typed errors have tests. |
| Oversized valid JSON prefix accepted | `LimitReader(cap)` could hide a suffix after a valid document and report success. | Read cap+1, reject overflow, then decode the full document. Applies to persona JSON and selected config, transfer, broker, policy, auth-accessor and housekeeping responses. Tests stream more than 64 MiB and reject trailing documents. |
| Native-home override could erase the user's home ancestor | `CODEX_HOME=<parent of HOME>` passed the root/equal-home guard; the regression deleted a test user's documents. | Reject every ancestor of HOME, resolving intermediate symlinks while leaving final symlink unlink semantics intact. External dedicated native homes remain supported. Tests cover lexical and symlink paths. |
| Shared-temp cleanup trusted a filename prefix | Engine destruction recursively removed matching Grok temp directories without checking ownership or active use. | Reuse Grok's private-directory checks: UID, 0700 directory, regular marker, exclusive lifetime lease and process fence. Unrecognized paths survive; active owned paths remain residue. Tests cover idle, active and unowned paths. |
| Host sync silently omitted a broken engine | Any config discovery error was treated as an uninstalled engine, allowing another engine's success to hide it. | Missing defaults remain optional; missing explicit overrides and other discovery errors make sync fail visibly while healthy engines continue. Reuse canonical engine config resolution; reject non-regular configs and unknown engines. |
| Special files accepted as shared session locks | A FIFO could be accepted as a lease inode. | Nonblocking/no-follow open and a regular-file check precede flock. FIFO regression and existing lease/exec-handoff tests exercise the shared primitive. |
| Malformed signing key could panic | Direct detached verification passed an invalid-length key to Ed25519. | Validate key length and return a normal error. Raw/base64 signature behavior remains covered. |
| CONNECT read-ahead lost | The proxy discarded the reader returned by `Hijack`; a TLS hello sent with CONNECT could vanish. | Forward buffered bytes before copying the live tunnel. A single-write CONNECT+payload regression failed before the fix. Forward request EOF with TCP half-close. |
| Proxy leaked connection-only headers | Only Connection and Proxy-Connection were removed; proxy credentials and Connection-nominated headers reached upstreams, and response hop headers reached clients. | Strip fixed and nominated hop headers in both directions. Integration test verifies request/response filtering. |
| Proxy cancellation left hijacked sockets open | The context was ignored and HTTP Shutdown does not own hijacked tunnels. | Track tunnels, close them on cancellation/Stop, close idle upstream connections and make Stop idempotent. Cancellation test and race detector verify shutdown. |
| Required static-analysis gate was red | Unused functions/field, dead test initialization and small standard-library diagnostic violations remained. | Remove unused forwarding/declarations and correct the flagged calls/constants without widening waivers. |
| Traced dependency graph escaped the security gate | The default scan found no reachable advisories, while `-tags cxx_otel` reported seven across HTTP2, gRPC and OpenTelemetry. | Upgrade x/net to 0.60.0, gRPC to 1.83.2 and OpenTelemetry to 1.45.0; align the Go module, workspace, CI and bakery on patched Go 1.26.9. Add the traced vulnerability scan to CI. |

Advisory details and fixed-version ranges come from the Go vulnerability database:
[HTTP2](https://pkg.go.dev/vuln/GO-2026-6617),
[gRPC](https://pkg.go.dev/vuln/GO-2026-6348) and
[OpenTelemetry](https://pkg.go.dev/vuln/GO-2026-6505).
The traced reachability report is static analysis, not a demonstrated exploit.

## Architecture assessment

The useful shared modules already exist: signed config/fleet config, atomic
publication, auth generation/CAS and logout fences, process supervision,
account leases, native writers, skill ownership, cron/maintenance coordination,
terminal rendering and update installation. Their existing adversarial and
concurrency tests form much of the acceptance matrix.

The HTTP retry and trust rules were duplicated and had already diverged. They
now live in `internal/httpguard`, which depends only on the standard library.
Engine adapters keep typed errors and account observations. Grok private-temp
cleanup similarly has one implementation shared by sweeping and destruction.
Global config discovery now uses the existing per-engine resolver.

Codex and Claude's large lifecycle implementations still express different
native auth formats, effort/model configuration, refresh ownership and cleanup
rules. Grok retains its access-only broker and central refresh ownership. This
release keeps those state machines and their public entrypoints intact. It does
not introduce a generic engine interface that would hide these differences.

Reviewed release invariants include staged four-platform publication, immutable
version directories, manifest merging that preserves rollback builds, active
signing-key embedding, checksum-before-execution and atomic executable swaps.
Provider binary versions remain fleet-controlled; age alone does not override
their tested pins. The README's obsolete 15-minute cron description is corrected
to the implemented nightly schedule.

## Verification

Verified on Linux amd64 on 2026-10-27 with Go 1.26.9:

| Check | Result |
| --- | --- |
| `go build ./...`, `go vet ./...`, gofmt and diff checks | Passed |
| Complete `go test -p 2 ./...` | 64 tested packages passed |
| Complete `go test -race -p 2 ./...` | 64 tested packages passed |
| `go vet -tags cxx_otel ./...` and complete tagged test suite | Passed; 64 tested packages |
| staticcheck 2025.1.1, with existing waivers unchanged | Passed |
| govulncheck, both default and `-tags cxx_otel` | No vulnerabilities found after dependency updates |
| Wrapper/API contract suite and API typecheck | 213 tests passed; typecheck passed |
| Additional deployment/build contracts | Passed |
| Manifest merge and immutable publication Python tests | Passed |
| Real-PTY terminal matrix | 451 cases passed |
| Linux/macOS × amd64/arm64 release builds | All four compiled |
| Real native help/argument oracle | Codex 0.164.0 and verified Grok 1.0.70 passed |
| Pinned Grok 1.0.50 registry canary | All four SHA-512 archives, Brotli extraction and native architecture checks passed |
| Workflow parsing, patched toolchain pins, shell syntax and module tidiness | Passed |

The optional authenticated native provider prompt/renewal canaries were not run.
No provider credentials were issued or refreshed for this review. Linux test
execution and macOS cross-compilation do not establish runtime behavior on a
physical Mac. Config signatures and artifact identity are also checked against
production during rollout, separately from these source checks.

## Deployment and rollback contract

Publish through `scripts/deploy.sh --no-backup --no-cleanup --service api` on
`docker01.uggs.io`, using the existing
`/var/docker_data/codex-auth.uggs.io/app` checkout. Retain the current API image
under a rollback tag before building. Bareos remains the backup system; this
release creates no local database/storage/credential backup archive. Deployment
health/version SQL probes pass their password through process-scoped `MYSQL_PWD`
instead of placing it in the process argument list.

Verify clean/pushed source, the running API's build revision and health,
migration status, all four served manifests and binary hashes, and the version
reported by the served executable for the multicall paths. Publication offers
the new wrapper to hosts; it does not replace already-running native sessions
or prove that every offline host has upgraded.

Rollback uses the retained API image and the prior immutable wrapper release,
0.9.137. Select the old wrapper through the existing rollout/version controls;
do not overwrite immutable 0.9.138 bytes. There is no schema change in this
release. Reverting source alone does not change a running image or wrapper.
