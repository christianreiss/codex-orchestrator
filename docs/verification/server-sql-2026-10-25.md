# Server and SQL verification after MCP repairs — 2026-10-25

Host: docker01.uggs.io. Initial main: `193a482600437a884591507c1d68bae8ddaa1d2e`.
Initial live API image: `cb634699f54313bc0ed5b6f2e336d08f0a0677c00d6f326606d2362e4d851e6d`.
All 540 API source-map entries matched the checkout. cxx 0.9.130 served on all
four platforms; all public readiness checks passed, 103 migrations applied,
zero container restarts/OOM events. This is fresh production evidence, not a
restatement of the earlier redesign acceptance.

## Finding and repair

In 30 minutes the API logged roughly 2,300 request refusals. The dominant code
was `agent_activity_binding_changed`; in the final five-minute baseline there
were 302 of those and 100 `agent_messaging_relay_uncertain` refusals.
The activity reducer still required the persisted receiver heartbeat to be
less than 45 seconds old. Owner-mode receivers deliberately keep current
presence in their authenticated stream instead of rewriting that timestamp.
Connected clients therefore retried a valid observation every two seconds.

Owner activity admission and projection now use exact connection presence or
the already protected legacy-drain proof. Engine, native identity, binding,
receiver generation, failure and session-terminal checks remain mandatory.
Admission rechecks authority during the volatile mutation. Duplicate observations
stay no-ops; neither activity observations nor their reads introduce SQL or
command receipts. Legacy callers keep their original heartbeat/evidence expiry.
Connection-bound owner responses have `expires_at: null` and invalidate on
disconnect; the Agents activity and current-turn delivery displays honor this.
The UI continues to distinguish native work, transport readiness and outcomes.
Applicable DESIGN rules: INT-6/7/8 and Live state transport. No new surface or
visual design exception. Unit/state checks are not visual/usability acceptance.

A regression reproduced the refusal before the change. Tests cover all three
engines, exact generations, duplicate reports, an hour-old heartbeat, no SQL,
disconnect rejection and display invalidation, plus legacy evidence ageing.

## SQL, retention and data integrity

- A 60.184-second baseline measured API **4.774%** and MySQL **1.459%** of one
  CPU core; a second 180.198-second mixed-load window measured **5.742%** and
  **1.203%**. These include live work, diagnostic traffic and coordination.
- SQL was sparse. Remaining DML included batched auth-call counters, actual
  portal/coordination changes and message expiry; diagnostic queries are not
  classified as application demand. This is not a zero-SQL production claim.
- The historical expensive scope-retention digest accumulated 971 seconds over
  89 calls, but last ran at **10:21:11 UTC**, before this verification. Its old
  count and the 52 accumulated slow queries were unchanged in current checks.
- No current lock waits, deadlocks or lock timeouts. InnoDB history list was 6;
  two application connections were sleeping between operations. General and
  binary logging are disabled; no configuration changes were needed.
- MySQL data directory: **1.1 GiB**. Table/index allocation about **689.53 MiB**,
  with **365 MiB** reported reusable free allocation. These are storage figures,
  not live object sizes or exact reclaimable-byte promises. Stale table row
  estimates must not be presented as actual row counts.
- Actual logs: **1,061 rows / 125,788 bytes of details**, none older than the
  effective 14-day policy. Actual bus messages: **2,373 rows / 11,220,391 bytes
  of encrypted content**. Larger existing files include reusable deleted pages;
  no table rebuild or production data deletion was performed by this audit.
- Retention remains armed: audit 14 days, history 24 hours, quota 7 days. Paused
  schedules are protected. Recent retention-family completion timestamps and
  bounded deletions were observed.
- Receipts: roughly 86,600 retained, including older internal/legacy classes.
  Hourly creation fell from 4,111 at 07 UTC to 359 in the completed 13 UTC hour;
  retained history is not current query rate. No receipt purge/reset was used.
- Referential checks returned zero missing current provider payloads, Skill
  parents, live-session hosts, undeleted schedule targets and unresolved-message
  targets. Grok account 7 remains generation 88 / verified / refresh idle.

One protected old cxx 0.9.127 relay still holds accepted work. Registration of
another instance correctly returns `agent_messaging_relay_uncertain` rather
than replaying or deleting that work. Its repeated reconnect attempts are
separate from the repaired activity bug and remain a stated limitation.

## Verification and delivery

Checks and final production samples are recorded below after rollout. No new
production dump, storage archive, monitoring daemon or forced native restart is
part of this verification. Synthetic MySQL uses an isolated temporary container,
not production credentials or copied production data.

Pre-rollout checks:

- API TypeScript passed; full ESLint: zero errors, 228 existing warnings.
- 64 targeted activity/quiet-owner/receiver/security/response-proof checks passed.
- Six real-MySQL checks passed: core SQL budget with restart/replay, owner Portal
  for all engines, legacy activity for all engines, and retention due transactions.
- Full-server isolated observation passed: 200 simulated communicators, real TCP
  HTTP/WebSocket transports, 60-second quiet window, zero application SQL. No
  browser tabs in this run; CPU was not saved as a separate result artifact.
- Svelte check: zero errors/warnings; 999 frontend tests passed; frontend build
  passed. Existing unresolved-at-build-time font-path warnings are checked against
  the served static paths separately. No layout or CSS source changes.

- Complete API suite: **471 files / 6,013 tests passed**, 105 DB/opt-in files /
  1,083 tests skipped. The separate six real-MySQL checks and 200-client quiet
  observation above were explicitly enabled; skipped suites are not claimed run.
- Public health, readiness, Admin HTML and both sampled WOFF2 font paths passed
  with curl certificate verification enabled. Python 3.13's separate TLS probe
  rejected a CA key-usage extension; curl succeeded without `-k` or trust changes.
- No Go sources changed, so Go build/vet were not repeated. Full browser,
  Android build/device and all DB integration suites were not rerun. The current
  Android activity reader still applies legacy expiry/heartbeat rules; mobile
  activity-display compatibility needs a separate app update and is not claimed
  repaired by this server rollout.
