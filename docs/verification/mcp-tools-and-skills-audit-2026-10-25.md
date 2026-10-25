# MCP tools and server Skill audit — 2026-10-25

Status: repairs and post-deployment retests in progress. This report separates transport fixtures, functional calls and expected denials.

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
| Root Skill backlinks cannot resolve | Resolve exact root `SKILL.md` to the canonical manifest; retain engine, deletion, traversal and source-bundle checks. | Source-managed all-engine, managed root, visibility/deletion/traversal tests; live retest pending. |
| Long-lived bridge expires only in command views | Private metadata scopes now follow genuine same-epoch composed views; independently reconstructed snapshots receive a fresh scope. | Live Git reproduction plus fake-clock tests, disconnect/binding/token/restart fencing; independent static review by Jasmin found no blocker; additional held-view close and relay-disconnect tests pass. |
| Agent translate and current workflow HTTP 500 | Native live probes reached forbidden pool transaction paths under owner mode. | Repair delegated to Stephanie; live retest pending. |
| Broker Skill HTTP 401 and nine cached-read HTTP 409 failures | Native session header is missing from validated-cache forwarding; protocol response compatibility is under investigation. | Repair delegated to Stephanie; live retest pending. |

## Current test evidence

- Existing MCP/Skill baseline: 409 tests passed before the additional regression probes.
- Complete central registry, including optional operator/role/spawn tools: 98 tools, schema plus success/error response contracts for Codex/Claude/Grok (300 tests). These use service doubles and do not replace business-semantic tests.
- Real-MySQL target is the disposable `rosa-mcp-audit-mysql-20261025` instance on loopback port 33306, database `codex_mcp_audit`, with its own credentials and temporary storage. Production configuration is excluded through `ENV_FILE=/dev/null`.
- 251 selected real-MySQL integration tests passed for MCP, Git Director, project board, projects, Secrets and Skills; two additional owner todo SQL rollback/success tests passed. An additional 455 real-MySQL Messaging/Coordination/Workflow tests passed (708 DB tests total).
- TypeScript and full ESLint passed; 228 pre-existing warnings remain (zero errors). The first complete API run had 5,974 passes, 1,083 deliberate DB/opt-in skips and one false positive: the public Compose runner URL is intentionally present in bundled installation docs. The artifact tripwire now exempts only that exact documented default under AUTH_RUNNER_URL; custom URLs and secrets remain covered (nine targeted artifact tests pass). The complete rerun passed: 470 files, 5,984 tests; 105 files / 1,083 DB- or opt-in-dependent tests intentionally skipped and relevant DB coverage run separately.

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

Jasmin removed temporary files, notes, memories, synthetic secrets, disabled schedules and transfers; the test Skill was soft-deleted, the own project archived and its cards completed. Git registrations/leases were released. Audit history is retained. The final report will add the deployed SHA, live retests, remaining limits and test-container removal.
