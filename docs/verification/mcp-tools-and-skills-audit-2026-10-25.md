# MCP tools and server Skill audit — 2026-10-25

Status: server repairs deployed and independently retested. Existing native supervisors retain their old transport until resumed under cxx 0.9.130. This report separates transport fixtures, functional calls and expected denials.

## Scope and ownership

Operator requested a full MCP/operational Skill check with Jasmin and Stephanie. Rosa-Maria owns server dispatch, atomic project todos, root Skill links, integration and deployment; Jasmin tested the 91 live central tools and Skill content; Stephanie tested the 82 native agent tools and all three engine bridges. Production probes use each agent’s own authenticated broker. Test writes use uniquely named disposable records. Real host reboots, fresh-start recovery and unrelated external service actions are not smoke tests.

## Evidence before repair

- [Central tool matrix](mcp-cdx-coverage-2026-10-25.tsv): all 91 central tools invoked; 73 functional/own-fixture cases, five negative-only cases, 13 failed tools. Two otherwise functional Skill tools also failed through the native broker.
- [Native agent matrix](cxx-agent-mcp-audit-2026-10-25.md): 82 tool contracts; additional live semantics and limits are recorded separately.
- 55 Skill manifests retrieved with matching advertised manifest SHA-256; 23 support files available; four root `SKILL.md` backlinks failed. Support endpoints did not publish expected file hashes, so computed digests alone are not an integrity proof.

## Reproduced defects and repairs

| Defect | Reproduction and repair | Verification |
| --- | --- | --- |
| Missing ping; silent empty batch; malformed IDs/params dispatch | Authenticated live probes reproduced all four. Dispatcher now handles ping, rejects empty batches/IDs and validates named params before dispatch. | Twelve new cases observed red then green; HTTP route tests pass. |
| Todo returns error after card committed | Move todo audit into the same board owner command; avoid a second audit outside the command. | Lifecycle owner tests plus real-MySQL injected audit failure: SQL card/event/log and owner state all remain unchanged on failure. |
| Root Skill backlinks cannot resolve | Resolve exact root `SKILL.md` to the canonical manifest; retain engine, deletion, traversal and source-bundle checks. | Source-managed all-engine, managed root, visibility/deletion/traversal tests; independent live retest passed (details below). |
| Long-lived bridge expires only in command views | Private metadata scopes now follow genuine same-epoch composed views; independently reconstructed snapshots receive a fresh scope. | Live Git reproduction plus fake-clock tests, disconnect/binding/token/restart fencing; independent static review by Jasmin found no blocker; held-view close and relay-disconnect tests pass. |
| Agent translate and current workflow HTTP 500 | Native live probes reached forbidden pool transaction paths under owner mode. | Stephanie’s patch integrated; local Owner/cache regression tests pass; independent live retest passed (details below). |
| Broker Skill HTTP 401 and nine cached-read HTTP 409 failures | Paired native headers and expiry proof were lost; old owners also accepted unsupported cache requests. Preserve proofs and check owner capability before dispatch. | Regression tests pass; server reads pass live via batches. Existing supervisor single-call behavior remains limited until replacement (details below). |

## Current test evidence

- Existing MCP/Skill baseline: 409 tests passed before the additional regression probes.
- Complete central registry, including optional operator/role/spawn tools: 98 tools, schema plus success/error response contracts for Codex/Claude/Grok (300 tests). These use service doubles and do not replace business-semantic tests.
- Real-MySQL target is the disposable `rosa-mcp-audit-mysql-20261025` instance on loopback port 33306, database `codex_mcp_audit`, with its own credentials and temporary storage. Production configuration is excluded through `ENV_FILE=/dev/null`.
- 251 selected real-MySQL integration tests passed for MCP, Git Director, project board, projects, Secrets and Skills; two additional owner todo SQL rollback/success tests passed. An additional 455 Messaging/Coordination/Workflow and 80 Provisioning/Recovery/Role/Scheduler/Feedback tests passed (788 real-MySQL tests total).
- TypeScript and full ESLint passed; 228 pre-existing warnings remain (zero errors). The first complete API run had 5,974 passes, 1,083 deliberate DB/opt-in skips and one false positive: the public Compose runner URL is intentionally present in bundled installation docs. The artifact tripwire now exempts only that exact documented default under AUTH_RUNNER_URL; custom URLs and secrets remain covered (nine targeted artifact tests pass). The complete rerun passed: 470 files, 5,984 tests; 105 files / 1,083 DB- or opt-in-dependent tests intentionally skipped and relevant DB coverage run separately.

After the runtime patch integration, 73 focused API tests plus TypeScript and changed-file ESLint passed. The three new native-scope Go cache regressions passed locally with `-race`; `go build ./...` and `go vet ./...` passed in the isolated toolchain container. Stephanie separately reports the full Go suite and full communicator race suite passing for the transferred patch. Her full API run had three reproducible non-root fixture permission failures; our root-capable full API baseline passed before integration, followed by the targeted integration checks.

## Skill inventory

| Skill | Manifest digest |
| --- | --- |
| `agentic` | matches |
| `ask-matt` | matches |
| `bookstack.documentation_manager` | matches |
| `checkmk-deploy-verify` | matches |
| `checkmk-local-checks` | matches |
| `code-review` | matches |
| `codebase-design` | matches |
| `diagnosing-bugs` | matches |
| `docker-restart` | matches |
| `domain-modeling` | matches |
| `emails` | matches |
| `emergency` | matches |
| `fast` | matches |
| `feedback` | matches |
| `fleet-reflect` | matches |
| `gime` | matches |
| `git-commit` | matches |
| `grill-me` | matches |
| `grill-with-docs` | matches |
| `grilling` | matches |
| `handoff` | matches |
| `implement` | matches |
| `implement-spec` | matches |
| `improve-codebase-architecture` | matches |
| `noop` | matches |
| `pr` | matches |
| `private-tls` | matches |
| `prototype` | matches |
| `research` | matches |
| `retro` | matches |
| `setup-matt-pocock-skills` | matches |
| `sipit` | matches |
| `ssh-login` | matches |
| `tdd` | matches |
| `teach` | matches |
| `to-questionnaire` | matches |
| `to-spec` | matches |
| `to-tickets` | matches |
| `triage` | matches |
| `wait-what` | matches |
| `wayfinder` | matches |
| `wirefax` | matches |
| `wizard` | matches |
| `work-ldap` | matches |
| `writing-for-agents` | matches |
| `zammad` | matches |
| `afk` | matches |
| `coco` | matches |
| `conference` | matches |
| `invite` | matches |
| `reboot-safe` | matches |
| `skill-manager` | matches |
| `wake-cron` | matches |
| `watchdog` | matches |
| `workflows` | matches |

Operational manifests include `skill-manager`, `coco`, `workflows`, `invite`, `conference`, `wake-cron`, `watchdog`, `reboot-safe`, `emergency`, `docker-restart`, `ssh-login`, `diagnosing-bugs` and `fleet-reflect`. Retrieval and references were checked; instructions that change external services were not blindly executed.

## Protocol references

- [MCP 2025-03-26 ping](https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/ping).
- [JSON-RPC 2.0 request IDs, named parameters and empty batches](https://www.jsonrpc.org/specification).

## Compatibility probe

On still-running old native supervisors, a one-element standard JSON-RPC batch for the same read-only request succeeds with the unchanged authenticated broker identity (`skill_list` and `shared_memory_list` verified). Batches use the normal managed request path and preserve paired headers. This is a diagnosis/transition path, not permission to bypass authorization or replay a write. New single-call transport behavior requires the fixed wrapper in the supervising process.

## Report references

- Protocol validation: `88834960-16a1-4bae-967e-8ef1dff661f3`.
- Owner command credential scope: `e79aef5a-bdde-4f78-bc54-a5f370373e58`.
- Todo atomicity: `72da81f3-95d4-4871-babe-e8620af48831`.
- Root Skill links: `9dd3f455-7480-471d-91a9-0b3f39af2be8`.

## Cleanup and remaining limits

Jasmin removed temporary files, notes, memories, synthetic secrets, disabled schedules and transfers; the test Skill was soft-deleted, the own project archived and its cards completed. Audit history is retained. The isolated MySQL container and its tmpfs database were removed. Newly created deployment rollback image tags and cutover metadata were deleted after health verification, as requested; deployment used `--no-backup`. Production data, Bareos, running images and unrelated workloads were preserved.

## Deployment and independent live retest

On docker01, `scripts/deploy.sh --skip-git --no-backup --no-cleanup --service api` deployed `b97d194fe7f31fa75150e1e1077aac73e53e5fcd` (clean source). Running API image: `sha256:af67beae9165175e27f40aac7e774979c50fbfc6b86685faf75a6de38de81341`. All four cxx 0.9.130 platform artifacts were published. API, media worker and auth runner remained healthy; 103 migrations applied, zero pending and zero drifted. Eight critical source files match the running sourcemap exactly.

Jasmin independently retested all 13 formerly failing central tools: the four todo mutations pass as normal single calls, with update/done/undone read back from the board. All nine content reads pass through authenticated one-element JSON-RPC batches with the fixture marker confirmed in the returned body. Skill list/retrieve and all four repaired root aliases also pass through that path; alias bodies and SHA-256 exactly match the canonical manifests. This was a targeted retest, not a second complete 91-tool sweep. Temporary fixtures were cleaned and cleanup read back. Sanitized result summary: [live retest](mcp-live-retest-2026-10-25.json).

Stephanie independently verified `agent_translate` and `agent_workflow_run_current` on the deployed server without HTTP 500 and closed their feedback reports as resolved/deployed. Rosa-Maria verified the four protocol responses live and successfully registered/deregistered Git after reproducing the former long-lived credential expiry.

The host wrapper was updated normally from 0.9.128 to 0.9.130. Reloading MCP configuration in the current native thread preserves the same identity but does not replace the supervising process. Existing supervisors on both tested hosts still produce HTTP 401/409 on the affected single-read path. Therefore a fresh supervising process under 0.9.130 is still required for those existing sessions. New native-scope client/owner behavior is regression-tested for all three engines; a regular short native cxx 0.9.130 canary against production passed normal single calls for `skill_list`, `skill_retrieve`, `shared_memory_list`, `shared_memory_search` and `resource_read` (root `SKILL.md`). No uncertain write was replayed, no native transcript was killed and no reboot was used as a test.

No authentication, TLS or authorization check was weakened. Destructive operations and actions against unrelated external services were covered through contract/fixture/denial tests where appropriate rather than executed against real infrastructure. The API full suite described above predates the final peer runtime patch; targeted integration checks, typecheck, lint, Go build/vet and focused race tests cover the integrated patch. No frontend changes or frontend checks were necessary.


## Terminal acknowledgement follow-up

The fresh native canary exited zero but exposed a finalization warning: the session was already correctly `completed`, ended and fenced at binding generation 2, then the global coordination tick inherited the old portal proof and returned `receiver_binding_changed`. The fix isolates only that awaited system maintenance tick with `withOwnerBackgroundScope` in owner mode. The authenticated terminal action and response guards remain unchanged. A focused HTTP regression reproduced the stale-proof 409 before repair and passes after; invalid binding still returns 409 and never runs maintenance. Owner-response plus portal-security suites: 23 passed. Stephanie independently reviewed the causal path and narrow fix. Feedback: `54aa0b83-414e-4a9e-aa7f-d2c39a582f2d`.
