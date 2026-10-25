# Open feedback review — 2026-10-25

Initial inventory: 18 nonterminal Orchestrator reports, across all result pages.
Final central snapshot at 2026-10-25 19:58 UTC: **7 resolved, 3 duplicates,
8 blocked; zero open or in progress**. Every remaining blocker has a reason and
new evidence or an explicit explanation of the missing historical evidence.
Scope: reproduce actionable defects, fix and test them, distinguish duplicate episodes
and historical reports whose cause cannot be established. No authentication bypass,
provider refresh replay, claim takeover, or forced restart of another native process.

## Verified changes

- Local path/git/service claims default an omitted host ID to the authenticated host.
  Explicit invalid IDs and malformed remote resources remain rejected.
- Claim denials include caller-only connection diagnostics and recovery commands in
  both structured metadata and readable messages. All engines document native child
  MCP identity sharing; children cannot rename/rebind the parent or release its claims.
- Git registration denials explain original-process/private-broker requirements and
  explicit nested-workspace binding. Original owner checks remain mandatory.
- Retention's future deadline clock skips malformed legacy timestamps with indexed
  keyset pages; the normal path still uses two queries. Delete predicates are unchanged.
- Verification retries use a relative delay consumed after the async handler returns;
  elapsed attempts retain the existing 30-second recovery bound instead of a 1ms race.

## Evidence

- Complete API suite: **6,355 passed, 1,100 skipped**, 481 passing test files.
- TypeScript typecheck and ESLint passed. No wrapper source changed in this batch;
  published wrapper remains **0.9.133**.
- Claim/Git/diagnostic selection: 55 passed; owner recovery/renderer/diagnostic
  selection: 139 passed; provider retry selection: 31 passed.
- Retention: 22 unit/boundary cases and two private MySQL collation cases passed.
- Coordination: 23 real MySQL cases passed, including a fresh baseline-only database.
  The initial fixture failure was missing name-pool migrations; the suite now applies
  canonical migrations itself. Other coordination/Git MySQL cases passed initially.
- Synthetic idle check: 200 TCP communicators representing all three engines,
  90.001 seconds, zero application SQL/business frames/failures; combined server and
  simulated-client CPU 1.669% of one core. No provider accounts or real browser/200
  native CLIs participated. This is not a fleet-wide absolute CPU/SQL minimum claim.

## Report disposition and limits

| Report | Result / remaining evidence |
| --- | --- |
| ea04a1c6 | Resolved: local-host default; actual post-rollout native MCP probe passed. |
| e7455174 | Duplicate of ea04a1c6. |
| a1ac490b | Fixed actionable claim connection diagnostics. |
| 091bf3f0 | Fixed shared native-child identity guidance for all engines. |
| f8e2ba56 | Fixed invalid future retention clock. Invalid past-only batches remain a separate limitation. |
| 7ba94e71 | Fixed verification retry deadline race. |
| 38dd85c6 | Fixed missing-attachment/workspace diagnostics; real Grok Git success remains unverified. |
| c17d4fca | Event/deadline implementation and wrapper release verified; existing old native processes were preserved. |
| e16b4dee | Blocked: exact-owner/continuation recovery is tested, but historical uncertain emulator outcome lacks proof for safe revival. |
| 8313331a | Duplicate of resolved terminal-finish report 54aa0b83; source eab8be5b, fresh CLI completion verified. |
| dded70b9 | Same reported Grok reconnection episode as 7a5b72ee; preserve its additional MCP-read 401 symptom. |
| 7a5b72ee | Needs versioned Grok broker reproduction after provider login. |
| eaf1ecc6 | Historical expired-bridge/reconnecting episode lacks original proof; current Grok login blocks native retest. |
| ca015ff1 | Capture code fixed previously (8d98df3a); account 7 recovery still requires correct-account reauthorization. Never replay uncertain refresh. |
| 3257e1b7 | Historical unattributed writers: actor/native provenance missing. |
| fe125294 | Historical parent rebinding not reproduced; shared identity is not proof of the original cause. |
| 836e9fb6 | Historical one-off request 500 lacks server trace; retry success does not establish cause. |
| 58d6c34c | BrowserOS 30s timeout reproduced remotely; tab loss did not reproduce. Original flow/CDP trace or upstream source required. |

Sigrid's BrowserOS probe used only a new private tab: a 45-second promise timed out
at 30,010ms, while that tab remained readable. Chrome 155.0.8309.26, protocol 1.3;
BrowserOS build unknown. Separate read-only accounts.x.ai inspection showed a logged-in
profile, but its identity could not be matched to account 7 through normal UI. No login,
consent, device flow, refresh, cookies, or credentials were accessed or changed.

## Deployment and rollback

On docker01, `scripts/deploy.sh --no-backup --skip-wrappers --no-cleanup` completed
successfully at 19:57 UTC. Deployed source:
`7590bfb710a60659dc7911ed9770abb6c9934981`; actual running API image:
`sha256:1dd811a608e0608fbfaca428a0f3568c4541b4a95d5544fe65c38aab995b04b6`.
Health passed, restarts zero, 104 migrations applied with zero pending/drifted.
All eight changed implementation files match the running server source map.
The native MCP probe that failed before deployment now returns an active local
claim with authenticated host 245; the probe claim was released. The existing
operation claim survived with the same native instance and no expiration.

The API was rebuilt/recreated; media worker was restarted by the normal owner
cutover. Existing native agent processes were preserved. No Go or UI source changed;
Go/frontend suites were not rerun for this server-only batch. The API canonical suite
and selected real-DB suites ran; the entire DB integration suite was not run.

Actual deployment evidence and final feedback statuses are also recorded centrally. Prior code
can be rebuilt from 95cdff7125534994a24507bc08285c30197ca5d2. No schema change,
database dump, or Bareos configuration change is part of this batch.

The private tmpfs MySQL test container/helper were removed after checks. Verified
cutover metadata and its two temporary rollback image tags were removed after health
verification, under the operator's backup-cleanup instruction. Their deletion is
recorded in `/var/tmp/codex-zk-cleanup-20261025.json`; source remains rebuildable from Git.
