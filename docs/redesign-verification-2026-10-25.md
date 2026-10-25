# Stateful redesign verification — 2026-10-25

Target: docker01.uggs.io. Production rollout and final production measurements
are pending while this receipt is being assembled. See [REDESIGN.md](../REDESIGN.md).

## Functional gates

- Node 22.23.3 typecheck passed. ESLint: zero errors; 228 existing/source warnings remain.
- Complete API run: **469 files, 5,757 tests passed**; database-gated/opt-in cases run separately.
- Complete isolated MySQL integration: **179 files, 1,957 tests passed**; one opt-in idle file and two environment-specific cases skipped in this run. The idle file runs separately below.
- Go full tests, release-manifest tests and `go vet ./...` passed. Local protocol-3 tests also passed with the race detector, including 10,000 hits for each engine, concurrent fill, scope isolation, expiry, invalidation and warm native admission.
- Real terminal presentation matrix: **451 cases passed** across all three engines.
- Svelte check: zero errors/warnings; **997 frontend tests passed**; static build passed.
- Affected Chromium policy/retention/housekeeping checks: **17 passed**, including save, preview, confirmation, pushed completion, dirty-draft conflict and read-only/accessibility checks.
- Candidate production Docker image booted with its normal command against a freshly initialized isolated MySQL database; all 103 migrations applied. `/healthz` passed. Its server source map matched **540 current source files**, with no mismatches.

One pre-existing Grok process-lifetime test timed out during the first heavily
concurrent run; the complete subsequent Go run passed. An old database-boundary
unit test expected a SQL transaction around a protected RAM read; it now verifies
zero transactions while retaining writer denial and explicit cold reads. The
corrected three-file focused run passed 20 tests, followed by the clean full API run above.
The first five-tab deliberate-offline exercise reported a dynamic-import failure;
its repeated full exercise passed. No assertions were disabled.

## Controlled idle matrix

Real Node HTTP/WebSocket server, real isolated MySQL, simulated communicator TCP
clients, all three engines, real Chromium admin tabs. No provider accounts are
configured in this fixture: actual provider refresh work is covered by functional
tests and production observation, not claimed as idle work here. Reported Node
CPU includes the simulated clients. Transport pings are allowed; business reads
and SQL are measured independently. Each ordinary observation is 12 seconds;
the 200-communicator/five-tab observation is 60 seconds. Reconnect follows the
window and must expose a host created while the browser was disconnected.

All nine matrix cases passed. The first two provisional samples were repeated
without the separate candidate-image boot. Node CPU below includes simulated
clients; MySQL CPU includes its own background baseline.

| Communicators | Tabs | Seconds | Node CPU, one core | Application SQL | Browser HTTP reloads |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 12 | 0.036% | 0 | 0 |
| 1 | 1 | 12 | 0.030% | 0 | 0 |
| 1 | 5 | 12 | 0.011% | 0 | 0 |
| 20 | 0 | 12 | 0.143% | 0 | 0 |
| 20 | 1 | 12 | 0.271% | 0 | 0 |
| 20 | 5 | 12 | 0.136% | 0 | 0 |
| 200 | 0 | 12 | 0.615% | 0 | 0 |
| 200 | 1 | 12 | 0.868% | 0 | 0 |
| 200 | 5 | 60 | 2.789% | 0 | 0 |

The final 200/five-tab case was repeated with Inspector and explicit frame
classification: zero business frames, 812 communicator pongs, ten browser pings,
zero SQL, no browser errors. That profiled pass measured 3.767% combined Node CPU
and 365 MB RSS (Vitest/server/simulated clients); the ordinary pass above measured
2.789%. Its sampled wall time was 59.33 s idle, 0.52 s GC and 0.50 s Inspector
`post`; the rest consisted of transport/timer work. Profile overhead is not
reported as ordinary production CPU. Across ordinary samples MySQL used roughly
0.44–0.64% of a core, including its own baseline, with zero application SQL.
The fixture has no paid provider inference and does not measure a Raspberry Pi.

## Production boundary

Before rollout: image `5c9a24a6f42f8f3746e12d7696f1dabdcfe75f0b2a1f19f267e33aab27fd8880`.
A 30-second mixed-workload sample measured API **5.832%**, MySQL **38.100%** of
one core. Its SQL included contact writes and retention discovery. This sample
is not a controlled idle benchmark.

The existing local owner is cxx 0.9.127, PID 4014766, serving three native leases.
It must drain normally; publication of a new wrapper does not prove that every
busy old process was replaced. New clients retain the protocol-2 compatibility
adapter while such an owner is active.

`/root/orchestrator-quiet-check.sh --seconds 30 --output /root/quiet-result.json`
uses [scripts/quiet-check.py](../scripts/quiet-check.py). It is read-only, resets
no SQL counters, emits no credentials and creates no backup. It records image,
CPU, network bytes and SQL digest deltas. Network includes transport, health and
measurement traffic; classify remaining production statements by actual workload.

No new SQL dump, storage archive, cron, watchdog or monitoring service is part of
this redesign. Bareos retains responsibility for recovery backups. Rollback must
preserve newly accepted work: use compatible images or repair forward, never
restore old database contents over new receipts/results.

## First production pass and handshake repair

Implementation `3120c9cb` booted as exact preflight-tested image
`bf7aec22abbb0083f8d705a843f8397aebd3b006420a4a828690e2f6993acd62`;
health/readiness verified all 103 migrations, signer 1 and four cxx 0.9.128 platforms.
The first 30-second sample had zero application SQL, but 6.854% API CPU and
1.475% MySQL CPU. Repeated `adapter_upgrade_required` exposed missing production
wiring: the optional state-protocol bakery flag was never passed by live callers.
Owner-mode configs now advertise the existing stream, and exact authenticated
attachments take precedence over a missing cached declaration. Detached/native/
generation fencing and work executor contracts remain mandatory.

The repair passed Node 22 typecheck/lint, 43 targeted unit checks and the real
MySQL messaging, SQL-budget/restart and legacy-grant tests. The initial focused
DB attempt preceded its migrations and failed an invitation assertion; the same
suite passed after the required migration setup. No assertion was removed.

Actual production content responses passed 10,000 subsequent local cache hits
for Codex and Claude: one cold server exchange per engine, about one second per
10,001 reads. These are ephemeral cache-library consumers using the existing
root owner's transport; push/revocation and actual native process launch are
covered by the isolated real-process tests, not claimed from this focused probe.
No credentials/native homes were copied and no paid inference was invoked.

Codex/Claude live admissions and releases succeeded. Grok live admission reports
`grok_refresh_uncertain`: account 7 has remained `owner_lost_after_intent` since
2026-10-24T20:03:42Z, before this redesign and unchanged by the probe. A fresh
subscription login is required; the uncertain rotating refresh token is not
retried or reset. This is an explicit outstanding external-auth prerequisite.

All ten previously open session IDs, 86 pending/uncertain work IDs and eleven
paused schedule IDs survived the cutover. The original local owner PID/start
identity and auth encryption-key fingerprint matched. The existing Advisor
service was restored with its existing volumes and image; it installed cxx
0.9.128 and all three engine binaries, without launching an advisor task.
