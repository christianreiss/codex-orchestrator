# Wrapper startup measurements, 2026-10-15

Scope: cxx/cdx/clx/cgx command entry to native engine exec. Provider startup,
model inference and time to an answer are outside the measured interval.

The baseline is the production cxx 0.9.85 artifact (commit e9c0c48c), SHA-256
`8d997e4c9f9b030f6e695be607ab88b11f4f2ee595acf06cc4fef940fbd7a76d`.
The initial candidate contains the 0.9.86 wrapper changes only. The server was
unchanged at 9463a89b for the following comparison.

Test VM: 10.2.0.215, test1.eulie.de, production host 257; existing private user
comm-elvira-ca1fb4ad, UID 999, HOME /opt/coco-comm-audit-elvira/home. The existing
production config, public signing key and account assignments were retained.
Only this user's idle communicator was stopped to install the baseline binary;
the former 0.9.84 artifact was preserved as cxx-before-startup-0.9.84.

For repeatable wrapper-only samples, the supported native-binary override selects
a small process that reports its monotonic entry timestamp and exits. Authentication,
account leases, signed content sync, portal registration and identity confirmation
remain real production operations. Background maintenance requests are disabled for
both builds. A separate real-native process sampler excludes version probes.

Eight samples per build and engine, serial and interleaved; the later five pairs
alternate build order. These are small observed distributions, not a p99 SLO.
All 48 launches exited zero.

| Engine | Baseline median, seconds | Wrapper candidate median | Reduction | Candidate range |
| --- | ---: | ---: | ---: | ---: |
| cdx | 2.307 | 1.919 | 17% | 1.383–2.435 |
| clx | 2.073 | 1.691 | 18% | 1.161–4.018 |
| cgx | 2.309 | 1.534 | 34% | 1.227–2.271 |

A real Codex baseline launch reached native exec at 2.228 seconds and returned OK.
Its diagnostic spans included account reservation 170 ms, post-assignment auth
468 ms, portal registration 375 ms, identity confirmation 102 ms and advisory peer
discovery 239 ms. The immediately started heartbeat overlapped those requests.
Inclusive spans are not an additive breakdown of all setup work.

The same wrapper-only probe on the busy biest host observed baseline 9.594 seconds
and candidate 5.735 seconds. A later diagnostic baseline was 2.480 seconds. These
single samples demonstrate variability; they do not establish a stable reduction
on that host. Server-side investigation independently observed waits on its host
row 32. The VM's medians cannot stand in for biest's current latency.

The wrapper removes the post-assignment auth request only when this launch's valid,
verified account and canonical digest match the newly acquired verified lease.
It takes newer quota controls from the lease. Changed accounts, rotated credentials,
incomplete snapshots and rejected candidates retain the retrieve. Grok reuses its
freshly leased access-only projection after the existing account, generation,
digest, expiry, scope and verification checks; incomplete old responses retrieve.
Identity confirmation and bounded advisory peer discovery run concurrently.

Raw initial VM samples are under /opt/coco-comm-audit-elvira/startup-20261015/;
local harness, diagnostic source and biest samples are under
/tmp/cxx-startup-f21ba129/. These are ephemeral evidence paths and contain no
intentionally copied credential files. Release acceptance and combined API results
are recorded after deployment below when available.
