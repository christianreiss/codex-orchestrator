# Stateful redesign verification — 2026-10-25

Target: docker01.uggs.io. Production implementation `8a96bf6b` is deployed and quiet-path verification passed.
The operator completed Grok re-login; live admission and release now pass. See [REDESIGN.md](../REDESIGN.md).

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

At preflight the local owner was cxx 0.9.127, PID 4014766, with three local
lease connections. Automatic update subsequently replaced it with cxx 0.9.128,
PID 1409800, with three local lease connections. This counter measures local
connections; native processes are checked separately. The three pre-existing
`codex` process IDs 1927348, 2441982 and 3243370 were still running with start
times before both cutovers. No native-process stop command was issued. Other
older clients retain the protocol-2 compatibility path while they drain.

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

Codex/Claude live admissions and releases succeeded. During that first pass, Grok live admission reported
`grok_refresh_uncertain`: account 7 had remained `owner_lost_after_intent` since
2026-10-24T20:03:42Z, before this redesign and unchanged by the probe. A fresh
subscription login is required; the uncertain rotating refresh token is not
retried or reset. This prerequisite was resolved by the operator login verified below.

All ten previously open session IDs, 86 pending/uncertain work IDs and eleven
paused schedule IDs survived the cutover. The original local owner PID/start
identity and auth encryption-key fingerprint matched. The existing Advisor
service was restored with its existing volumes and image; it installed cxx
0.9.128 and all three engine binaries, without launching an advisor task.

## Final deployed verification

- Production API implementation: `8a96bf6b0ef8a6c9f531fb844bd7834331ec1a71`.
- Image: `a843d200f08e040bbd3f7664bade977ff485632997f536ca0bd8741949fa31f0`, booted with its normal command in isolation before cutover; final runtime source map matched 540 source files.
- All public readiness checks passed: exclusive owner, 103 migrations, runner, signer and four cxx 0.9.128 platforms.
- Two successive bounded production windows: **60.213 s / 0.897% API CPU / 1.266% MySQL CPU**, and **60.167 s / 1.006% API CPU / 1.296% MySQL CPU**, each with **zero application SQL statements**. CPU is percent of one core. MySQL includes its own background and sampler overhead; this is a real mixed-client production sample, not universal controlled idle or a zero-CPU claim.
- Actual owner cxx 0.9.128, over its real Unix HTTP endpoint: **20,002 reads, two server confirmations, 20,000 local hits**, 14.823 s, 172,906 retained cache bytes. The live signed config selected cache protocol 3 and state protocol 1. Earlier focused cache-library probes also passed.
- API Node RSS was **196,708 KiB** (about 192 MiB). Its virtual address reservation is not resident document RAM.
- All 10 captured session IDs, 86 pending/uncertain work IDs and 11 paused schedule IDs remained present after the final cutover. Encryption and signing-key fingerprints matched. The local owner upgraded automatically; the existing native processes continued.
- Effective retention policy remains armed: audit 14 days, inactive history 24 hours, quota history seven days. No new SQL dump/storage archive was made. Temporary test databases/containers and Go/browser caches/images were removed; the pre-existing unrelated `.env.pre-advisor-20261017` was untouched.

Repeated `adapter_upgrade_required` errors disappeared after the handshake repair.
Remaining reconnect exceptions include genuinely uncertain old relay work, one
stale receiver binding and one ineligible host; these are retained authorization/
work-state decisions, not reasons to clear accepted work. No all-host native
restart or universal wrapper upgrade is claimed.

The repeatable script is `/root/orchestrator-quiet-check.sh`; the secret-free
measurement receipt is `/root/orchestrator-redesign-result-20261025.json`.
The existing pre-flight preservation branch is untouched; there is only the main
checkout, with no task worktree left behind.

Checks outside this scoped acceptance were not run: full tracing-tag/staticcheck/
govulncheck suites, the full Go race suite beyond the changed local-cache tests,
Firefox/WebKit browser suites, and physical ARM/Raspberry Pi execution. All four
wrapper platforms were cross-compiled and published. The isolated Go fixtures
exercise real native-process startup; live admission/release probes invoke no
paid inference. The subsequent operator login completed the remaining Grok live-admission check.

Portal delivery was unavailable because this deliberately bare-engine session
has no portal binding/tool. Milestone updates were delivered in the conversation.

## Grok login verified after operator recovery

On 2026-10-25 at 11:17:37 UTC the server accepted a new dedicated login from
`biest.eulie.de` for the existing enabled Grok account 7: canonical generation 88,
payload 766, verification `verified`, refresh state `idle`, error code cleared.
Its access expiry is 2026-10-25T17:17:36Z. A subsequent real `/auth/sessions`
probe through the existing Advisor communicator returned HTTP 200 with verified
auth; `/auth/sessions/release` also returned HTTP 200. No paid inference or forced
refresh was performed. This verifies central acceptance and admission; the
operator's interactive `cgx` launch on biest is a separate client-side check.
