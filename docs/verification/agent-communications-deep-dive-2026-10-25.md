# Agent communications deep dive — 2026-10-25

Operator-authorized inspection and regression-driven remediation on docker01,
with three independent native reviewers and attended Codex/Claude peers on
biest. Baseline source af483160; live API before this rollout 8d98df3a,
wrapper 0.9.132. Final deployment evidence is recorded below.

## Findings and implementation

| Area | Reproduction | Change |
| --- | --- | --- |
| Direct reads | Real Fastify response boundary disclosed after session revocation | Bind session/generation/address authority through final response |
| Group metadata | Session revoked during awaited read or just before response | Final RAM revalidation and response proof |
| Room history | Subscription removed while cold read paused | Recheck membership after read and at disclosure |
| Reused group slug | New group could import old encrypted publications by topic | Use immutable room-event group ID; remove unbound legacy fallback |
| Publish | One subscriber on ineligible host aborted fanout | Skip only known ineligible recipient, preserve unexpected-error fencing |
| Large history | Legal wait/digest/room pages exceeded wrapper response limit | Complete-item serialized byte pages, exact continuation, no body truncation |
| Acceptance ACK loss | Server accepted, both replies lost, tracker dropped before native exposure | Retain exact claim; reconcile acknowledgement before first native submission |
| Publish retry | Generated idempotency UUID lost with uncertain HTTP response | Preserve original UUID in uncertain-send error |
| Conference expiry | Minimum TTL extended queued task past room deadline | Cap internal expiry and fence fresh claim/acceptance, including existing rows |
| Deadline queue order | An excluded expired conference row blocked later valid work | Remove only unaccepted expired rows from ordering blockers |

Already accepted or uncertain work is not replayed, cleared or declared finished.
Result/progress replies to exact previously accepted work remain admissible.
Room-question notices use the exact conference deadline, including the separate
room-delivery association. Owner checks are RAM-based; legacy predicates reuse
the existing SQL statement rather than adding idle queries.

Compatibility: unbound legacy group publications are no longer reconstructed
into a shared-room timeline. Original recipient mailbox deliveries remain.
`agent_listen` may return `delivery_pending` for an unexposed, unconfirmed
acceptance; it cannot finish that work. A lost MCP process or unknown native
submission remains unknown/ambiguous; no automatic replay is authorized.

## Verification

Baseline: 446 tests across 30 communication suites against isolated MySQL, plus
the owner lifecycle test covering all three engines. Synthetic MySQL contains
no production data and no real provider credentials. The new privacy, response
boundary, byte-size, expiry and ACK-loss cases were reproduced red before fixes.

Targeted owner read/conference/byte-page matrix: 146 passed, including actual
Fastify boundaries, plus 110 pre-existing direct/task-result regressions.
Room privacy/size/history selection: 21 passed. Group recipient/response
boundary selection: 16 passed. Final canonical suite totals follow below.

### Native live evidence before final rollout

Temporary group 78b0890b-ee40-4b84-b24b-af4c53017e20,
slug zk-comms-20261025-4207ad92; only the operator's three test participants.
Both peers explicitly subscribed to that group and the parent agent feed.

Group publication 3415afda-ddbd-4011-8f0b-5a036794c789 reached both native
contexts once. Repeating its identical client UUID returned created:false with
the exact original publication and delivery IDs. Feed publication
6e1905fc-ea73-40bd-a9f7-36f15f870446 was also confirmed once in both contexts.
Claude initially required a hook hint followed by agent_listen for the feed;
Codex reported the feed later as a separate native turn. This is evidence of
actual consumption, without claiming immediate autonomous delivery in every case.

Shared room read returned event d49fd528-3c33-442c-9de4-207796501dc7 and the
correct marker; Claude replied in the room as c39e41eb-70ad-48f5-8432-70a307f2a478
with reply_to and no recipients. Ordinary contributions did not start new rounds.

Claude→Codex request 198e8716-bb50-444a-83e2-9ae363eb5e4f and reverse request
5848db58-0715-419b-897c-1fe5e811d32e each produced exactly one correct marker
reply, one attempt, and a persisted succeeded task result. No closing ACK loops.
These attended sessions retained their original native identities/binding 1.

### Explicit limits

Grok request af70c4d8-45a7-40dd-90ab-c3f3b9598d30 was accepted, but no native
answer or task result was observed. Remote inspection found a living Grok
process and work_active gate, not proof of provider success or its exact cause.
The separate account-7 refresh incident remains blocked on a fresh dedicated
operator login; the previous device code expired. No old grant was retried, no
accepted work was reset, and no new Grok session was used to mask this failure.
All-engine synthetic coverage therefore is not a three-engine native-live PASS.

No production native crash, host reboot or provider outage was forced. Fault
injection uses isolated real transports or synthetic ledgers. An absolute CPU
minimum and perfect liveness under every scheduler/provider failure are not
claimed. No extra idle polling or SQL loop is introduced by these fixes.

Feedback: 61490e11-cb07-49d0-910c-41bf7273ba64.


### Final source checks

Full API: 6,301 passed / 1,096 skipped, 477 passing files. The final targeted
unit selection passed 227 cases after the final disabled/archived-address
protection and deadline fixes. All changed-file ESLint checks passed with five
pre-existing unused-import warnings; final TypeScript status is recorded below.

The combined MySQL run passed 415 tests and failed seven in three suites while
a reviewer used the same synthetic database concurrently. Extra messages and
global enable/name flags contaminated those expectations. Those exact three
suites were rerun exclusively on a new database: all 122 tests passed. The
failed mixed run is retained as evidence, not counted as a clean full run.
Additional private-DB mixed-collation and index regressions both passed.

Production has mixed unicode_ci/0900 room IDs. The deadline SQL uses an exact
binary join at that boundary. Migration 0104 adds the missing message_id index
without rewriting payloads; isolated testing applied it twice and EXPLAIN used
ref access on the new key. The production table was empty at the preflight.

Go: 62 test-bearing packages passed in the full canonical run; layout alone
failed because sudo was absent from the disposable build image. With real sudo
installed only inside a disposable container, layout passed separately. Thus all
63 packages are covered; the original full-run exit was 1 and is not relabeled.
Build, vet and targeted race tests passed. No host sudo/PATH change was made.

Final TypeScript check passed on all source changes and added tests.
