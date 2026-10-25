# Lock expiration and native continuation — 2026-10-25

## Defects and final behavior

The operator requested inspection and then a code fix for resource claims, Git locks and expiration. Production source parity was verified before editing. The active checkout was held by Cora; tests and fixes started in an isolated snapshot until she verified her completed rollout and released the checkout. Her deployed activity repair remains the parent of this work.

- Legacy Board rows persisted as `timed` were unconditionally read as connection grants in owner mode, and the timed sweep was skipped. A finitely expired legacy card now reads as unheld and is durably expired, with a project event, in the next serialized board mutation. Unexpired timed rows are retained. Connection cards stay held after disconnect/restart even when a historical timestamp is old; missing/malformed timed deadlines are shown uncertain and require explicit resolution.
- `reported_unknown` resource claims could be renewed back to active. Codex, Claude and Grok independently reproduced this against their own synthetic service claims and cleaned those fixtures. Renew now rejects that state. Explicit original-owner ended/canceled reporting or operator resolution remains available.
- A completed same-native-transcript resume previously could not recover its old resource claims or Git registration. Explicit recovery now checks completed/ended prior lifecycle, original generation or terminal +1, same nonempty transcript, canonical address, host, engine, username and host fingerprint; no old attachment; current address binding and exact live native instance. The captured instance is rechecked through the transaction commit boundary. Reads do not transfer ownership. Foreign/running/failed/attached/unknown work is not adopted.
- Resource continuation preserves the original grant ID and resources and records an atomic audit. If an identical acquire was already queued in the new session, its waiting row is canceled under a fresh internal request identity to avoid the unique-key collision. Immutable acquire receipts keep their original waiting ID; status exposes `continued_by_claim_id` for that released alias. Conflicting work under the same request UUID is rejected.
- Git continuation withdraws old pending/allowed merge requests in the same transaction. It never inherits merge permission. Owner-mode merge grants remain absolute 15-minute grants, not extended by status calls. Connection registrations retain uncertain exclusion until exact recovery or explicit resolution.
- Connection Git mutation/release previously checked the live holder but did not always authenticate the *caller* as that holder. Native principal and session/generation must now match. Host authentication alone, a foreign native agent or the ended original session cannot release the registration. Separately authorized operator eviction keeps its own route.

These are coordination and server commit fences. They cannot stop arbitrary detached external processes. Lifecycle completion asserts the owner finished its external operation; an unknown operation remains uncertain. No authentication, TLS or native-instance check is bypassed.

## Verification

Three reproduced tests were observed failing before their repairs: legacy timed Board reclaim, exact-transcript claim/Git continuation, and unbound Git release. Targeted tests cover expired versus live timed cards, connection protection, exact identity separation, explicit unknown denial, duplicate recovery with one audit, an operator-unknown race and attachment replacement during receipt persistence. The latter rejects recovery and leaves the old RAM owner unchanged. Git tests also reject foreign and ended native callers.

The isolated MySQL instance is `rosa-lock-mysql-20261025`, loopback port 33307, database `codex_lock_audit`, with independently generated credentials and tmpfs data. Production configuration is excluded. A new real-MySQL test injects audit insert failures using test-only triggers: claim recovery and registration/lease withdrawal roll back in SQL and owner RAM, then retry successfully with exactly one audit each. It also covers same-request UUID collisions, persisted timed Board expiration versus a neighboring connection claim, a durable expiry event and stale-owner rejection.

The broader selected MySQL suites passed: 109 tests across coordination, Git Director, Board and continuation, followed by the enhanced continuation SQL regression. No production SQL was modified by these tests.

The first complete API run inherited a production-only Companion Firebase file path from `.env`: 6,012 passed, 16 failed, 1,056 skipped, with two additional suites failing setup. All six affected files were rerun with `ENV_FILE=/dev/null`: 18 passed, 28 intentionally skipped. No production configuration was changed. The clean complete rerun passed: 471 files, 6,028 tests; 106 files / 1,084 DB- or opt-in-dependent tests skipped. Relevant real-MySQL coverage was run separately.

Native Go agentportal and agentbus suites passed, followed by `go build ./...` and `go vet ./...` in an isolated toolchain container. cxx 0.9.131 carries matching native tool guidance for all three engines. Existing unused-import lint warnings are unrelated. TypeScript passed. Changed-file ESLint passed with two pre-existing unused-import warnings and zero errors.

The Fleet Advisor first requested concurrency/rollback evidence, then agreed with the supplied evidence and documented continuation contract. This was a design/evidence review; the advisor did not inspect the full diff or run tests independently.

## Tracking

- Same-transcript recovery: `bed6ba53-db39-4ba1-8715-094cef4d97c3`.
- Expiration documentation and legacy Board mismatch: `66f99def-d061-45b2-867c-e6bb99c326f2`.
- Unknown outcome renewal: `066def43-6b14-41dc-830f-373a95b31ead`.
- Git release caller attribution: `831b03eb-ffe0-452b-b215-d29b275fc537`.

## Delivery evidence

All pre-deployment checks passed. `scripts/deploy.sh --skip-git --no-backup --no-cleanup --service api` deployed `7942d30588f9f850b01c3d1b76545ba3859fa455` on docker01. Running API image: `sha256:84602f51565f72ebadf900d669db604841c4d4f0f7967d71b0d828b7d8185c5c`. cxx 0.9.131 was published for linux/darwin amd64/arm64. API, media worker and auth runner are healthy; 103 migrations applied, zero pending/drifted. Seven critical source files, including the preserved activity repair, match the running sourcemap exactly.

Independent live Codex (Sigrid), Claude (Thea) and Grok (Natascha) retests all reject renewal of `reported_unknown` with `claim_not_active`, preserve the uncertain state on read and allow the original owner to report completed. All own service fixtures were released. The deployed server remains compatible with their running 0.9.130 clients.

Sigrid re-registered her isolated Git fixture after the API restart and verified it active with its original native identity. Thea's one foreign `git_release(deregister:true)` call was rejected with `git_director_owner_uncertain` / “Registration belongs to another session binding”. Sigrid then independently confirmed the registration was still active and unchanged, released it as the actual owner, removed only her private test repo, released its path claim and restored her original workspace. [Sanitized live evidence](lock-recovery-live-2026-10-25.json).

The real historical timed Board claim (project 29, card 11, original expiry 2026-10-07T12:31:43Z) read as unheld after deployment. A normal authenticated `project_card_release` with its existing column explicitly selected persisted the timed-expiry audit at 2026-10-25T15:32:18Z. Its column stayed `backlog`; content was not changed. The first attempted cleanup call was rejected during schema validation because caller-owned username/worktree fields are not public arguments; no mutation ran, and the corrected normal call succeeded.

The disposable MySQL container/tmpfs and this rollout's new rollback tags/cutover metadata were removed after health verification. The backup timer remains disabled/inactive; Bareos was preserved. No new database backup was created. Rollback uses the previous Git revision or operator Bareos recovery, not a fresh local restore point. Task-owned coordination claims are released at completion. No frontend code was changed; browser/visual checks are outside this backend repair.
