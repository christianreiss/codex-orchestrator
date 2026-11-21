# Ten-minute idle acceptance, 21 November 2026

On biest.eulie.de the normal OCI application and a separately instrumented Fastify server each ran the entire 1/20/200 communicator × 0/1/5 Chromium-tab matrix against dedicated MySQL 8.4 instances. All nine cells in each set used real time. The one-communicator cell attached four native protocol sessions, one for each engine. The larger cells attached one session per communicator and covered all four engines. The native endpoints were protocol clients with synthetic identities. The Go wire-compatibility and real installed-wrapper checks are separate.

## Normal image and process boundary

The API ran its normal tini/Node entrypoint on its private filesystem and SQL schema. Browser tabs opened the compiled app and received their initial WebSocket hello before measurement. A separate process read the application and MySQL cgroup v2 `cpu.stat` counters. A schema-filtered delta of `performance_schema.events_statements_summary_by_digest` measured SQL before and after each quiet period. The observation process and Chromium ran outside the application cgroup. CPU percentages are fractions of one logical CPU. Each MySQL baseline used a preceding real ten-minute interval on the same dedicated instance. Negative differences are retained as sampling variation.

| Communicators | Tabs | Native sessions | Seconds | API CPU % | MySQL CPU % | MySQL baseline % | Δ percentage points | Compact renewals |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 4 | 600.002 | 0.0835 | 0.1994 | 0.1430 | +0.0564 | 4 |
| 1 | 1 | 4 | 600.002 | 0.0290 | 0.2931 | 0.2141 | +0.0790 | 4 |
| 1 | 5 | 4 | 600.002 | 0.0941 | 0.2085 | 0.1456 | +0.0629 | 4 |
| 20 | 0 | 20 | 600.001 | 0.1574 | 0.2067 | 0.1446 | +0.0620 | 20 |
| 20 | 1 | 20 | 600.000 | 0.1596 | 0.2038 | 0.1463 | +0.0575 | 20 |
| 20 | 5 | 20 | 600.001 | 0.1632 | 0.2049 | 0.1454 | +0.0595 | 20 |
| 200 | 0 | 200 | 600.007 | 0.6478 | 0.2096 | 0.1436 | +0.0660 | 200 |
| 200 | 1 | 200 | 600.002 | 0.6476 | 0.2004 | 0.1497 | +0.0507 | 200 |
| 200 | 5 | 200 | 600.001 | 0.5974 | 0.3388 | 0.2404 | +0.0983 | 200 |

Each row had zero schema SQL statements, zero browser HTTP requests, zero browser errors and zero business frames. Transport keepalives and compact authorization renewals were counted separately. Eight cells ran the application built at `ce3466b37` with image ID `1c4f11aac98f9a6108f5365fad617c9afb9e2365e47c2fd554420e7b482e46e2`. The 1/1 installation was observed both before and after the quiescent upgrade. The original 1/1 run at `39b3e8bc7` measured 600.001 s, 0.0671% application CPU and 0.1979% total MySQL CPU.

## Driver instrumentation and reconnect

The opt-in [idle observation test](../../api/test/integration/control-plane/idle-observation.test.ts) recorded SQL at the application driver, individual frame families, browser requests, a deliberate reconnect and the source digest before startup. Its process CPU includes its protocol clients and excludes Chromium. Setup, initial hydration and the deliberately induced reconnect were outside its quiet interval. The bridge TTL was the normal 900 s and profiling was disabled. The [cutover contract](../owner-cutover.md) documents parameters and capture method.

| Communicators | Tabs | Observed seconds | Node process CPU % | MySQL CPU % | Renewed streams | Reconnect visible |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 0 | 600.000725225 | 0.0651 | 0.2183 | 4 | no browser |
| 1 | 1 | 599.999525613 | 0.1012 | 0.2257 | 4 | yes |
| 1 | 5 | 600.000725307 | 0.1111 | 0.2178 | 4 | yes |
| 20 | 0 | 600.0003493849999 | 0.1475 | 0.2206 | 20 | no browser |
| 20 | 1 | 599.999647104 | 0.1777 | 0.2203 | 20 | yes |
| 20 | 5 | 600.0002842849999 | 0.2074 | 0.2232 | 20 | yes |
| 200 | 0 | 600.001649702 | 0.6662 | 0.2233 | 200 | no browser |
| 200 | 1 | 600.000158781 | 0.7374 | 0.2223 | 200 | yes |
| 200 | 5 | 600.0030399550001 | 0.8764 | 0.3803 | 200 | yes |

Captured source digest (Node 22, API sources, compiled SPA, lockfiles and test harness): `e8eff550e5b11e262b6129b8ddc63928b05879f8f507297c57004061d907fce7`.

At the baseline one quiet 600 s cell recorded 120 unnecessary Slop SQL reads and four attached-session writes. After those fixes, all nine cells had zero SQL but sent a complete state delta for each authorization renewal. The negotiated compact renewals removed that broadcast. Actual content changes, reconnect snapshots, expiry and revocation have separate functional tests. Sharing this physical workstation with other tests affects CPU scheduling. No provider accounts, simulated clocks or production services participated.

## Scheduled work after upgrade

A separate 600 s replay against the pre-existing installation deliberately retained the original host registration. At 17:24:03 UTC its documented 30-minute never-provisioned deadline expired. MySQL recorded host.pruned with reason never_provisioned, messaging.runtime.suspended, install-token deletion and the released bindings. The real browser received host.pruned and refreshed its views. The zero-business-work assertion failed in this window. We keep it as a scheduled-work observation and exclude it from the quiet matrix. The remaining tests exercise the no-deadline case independently.

## Integrated build with restored browser bookmarks

The nine normal-entrypoint cases were repeated from a Git archive at `f75b5f801e50b8a67c18810644f28fc8b4186419` in a third set of newly initialized schemas. OCI image ID: `d55fe3754f294aa7b6ae1e8b20a973a39145eb65d42123bf42900bf257b2990c`. Each API used its own storage, owner and database server; the preceding owners were stopped first. The browser and protocol clients were outside the application cgroups.

| Clients | Tabs | Seconds | API CPU % | MySQL CPU % | MySQL baseline % | Δ points | SQL / HTTP / errors | Renewals |
|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 1 | 0 | 600.003 | 0.0849 | 0.2082 | 0.1430 | +0.0652 | 0 / 0 / 0 | 4 |
| 1 | 1 | 600.008 | 0.0813 | 0.2880 | 0.2141 | +0.0740 | 0 / 0 / 0 | 4 |
| 1 | 5 | 600.001 | 0.0905 | 0.2158 | 0.1456 | +0.0703 | 0 / 0 / 0 | 4 |
| 20 | 0 | 600.002 | 0.1515 | 0.2145 | 0.1446 | +0.0698 | 0 / 0 / 0 | 20 |
| 20 | 1 | 600.001 | 0.1665 | 0.2144 | 0.1463 | +0.0680 | 0 / 0 / 0 | 20 |
| 20 | 5 | 600.003 | 0.1618 | 0.2128 | 0.1454 | +0.0674 | 0 / 0 / 0 | 20 |
| 200 | 0 | 600.002 | 0.6152 | 0.2185 | 0.1436 | +0.0749 | 0 / 0 / 0 | 200 |
| 200 | 1 | 600.001 | 0.6247 | 0.2097 | 0.1497 | +0.0600 | 0 / 0 / 0 | 200 |
| 200 | 5 | 600.001 | 0.6052 | 0.3581 | 0.2404 | +0.1177 | 0 / 0 / 0 | 200 |

The extra 1/1 in-place upgrade replay recorded 600.002 s, 0.0290% API CPU, 0.2931% total MySQL CPU, four compact renewals and zero SQL, browser HTTP requests, business frames or errors.

## Product image with the optional admin socket

Git archive `ee85552733a1edd7d388e3d44bb70bf4c4fbc10e`, production Dockerfile and image `8749bccef36695ebd96bd6a481c6b9c45f6c17aec79ae8b32cc2f5494d24c424`. Each former lab owner was stopped, then its dedicated MySQL server was observed alone for 600 s. A fresh schema and storage were initialized per cell and the same server was observed under the new owner for a further 600 s. This final round contains the rebuilt web client, JSON-stream correction and WebSocket HEAD correction.

| Clients | Tabs | Seconds | API CPU % | MySQL CPU % | Paired baseline % | Δ points | SQL / HTTP / errors | Renewals |
|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 1 | 0 | 600.001 | 0.0571 | 0.1318 | 0.1748 | -0.0429 | 0 / 0 / 0 | 4 |
| 1 | 1 | 600.002 | 0.0279 | 0.2005 | 0.2568 | -0.0563 | 0 / 0 / 0 | 4 |
| 1 | 5 | 600.001 | 0.0703 | 0.1318 | 0.1801 | -0.0483 | 0 / 0 / 0 | 4 |
| 20 | 0 | 600.000 | 0.1071 | 0.1344 | 0.1763 | -0.0419 | 0 / 0 / 0 | 20 |
| 20 | 1 | 600.001 | 0.1112 | 0.1398 | 0.1788 | -0.0390 | 0 / 0 / 0 | 20 |
| 20 | 5 | 600.002 | 0.1185 | 0.1346 | 0.1764 | -0.0418 | 0 / 0 / 0 | 20 |
| 200 | 0 | 600.002 | 0.4796 | 0.1342 | 0.1772 | -0.0431 | 0 / 0 / 0 | 200 |
| 200 | 1 | 600.000 | 0.4771 | 0.1335 | 0.1734 | -0.0400 | 0 / 0 / 0 | 200 |
| 200 | 5 | 600.001 | 0.4955 | 0.2153 | 0.3256 | -0.1103 | 0 / 0 / 0 | 200 |

The idle acceptance target concerns quiet client work. Database CPU includes housekeeping after schema creation, row registration and connections during the warm-up. The raw and baseline-subtracted numbers above keep that cost visible.

## Connector delivery and background setup retry

Production Dockerfile, Git archive `4332b4d1af5d0be187e23f98cb435c014c21a06a`, image `7675146adcc7561e2a1b94e91b591185189e8c2fbd44f92c259005dbdc05403e`. The MySQL-alone reference was collected on each pinned CPU pair before its application started. Each row counts one observed steady interval on biest.eulie.de.

| Clients | Tabs | Seconds | API CPU % | MySQL CPU % | Paired baseline % | Δ points | SQL / HTTP / errors | Renewals |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 600.004 | 0.0573 | 0.2021 | 0.1243 | +0.0778 | 0 / 0 / 0 | 4 |
| 1 | 1 | 600.001 | 0.0720 | 0.2115 | 0.1286 | +0.0829 | 0 / 0 / 0 | 4 |
| 1 | 5 | 600.001 | 0.0667 | 0.2091 | 0.1259 | +0.0832 | 0 / 0 / 0 | 4 |
| 20 | 0 | 600.001 | 0.1213 | 0.2088 | 0.1247 | +0.0842 | 0 / 0 / 0 | 20 |
| 20 | 1 | 600.000 | 0.1253 | 0.2109 | 0.1307 | +0.0802 | 0 / 0 / 0 | 20 |
| 20 | 5 | 600.001 | 0.1333 | 0.2093 | 0.1247 | +0.0846 | 0 / 0 / 0 | 20 |
| 200 | 0 | 600.001 | 0.5947 | 0.2088 | 0.1250 | +0.0838 | 0 / 0 / 0 | 200 |
| 200 | 1 | 600.001 | 0.6006 | 0.2074 | 0.1228 | +0.0845 | 0 / 0 / 0 | 200 |
| 200 | 5 | 600.001 | 0.6094 | 0.3563 | 0.1931 | +0.1632 | 0 / 0 / 0 | 200 |

Across these nine cells the observed frames were 26,520 transport pongs and 672 compact credential renewals. The business-frame count was zero.

## Native 0.9.195 and release-aware admin SPA

Production Dockerfile, Git archive `7cf32f10c68f8b460edc94305f7a4fff127b9097`, image `490c0de4f4dbef8738df951d7a61a7036ff1d76b61e0dd492f316200b46d6bc1`. The nine owners used new private schemas and volumes after the preceding owners had stopped. Wrapper artifacts matched the environment signer. Baselines are the same paired 600-second, MySQL-only measurements. The signing bootstrap used read-only lab keys with the container label of their dedicated fixture. Each row counts one observed steady interval on biest.eulie.de.

| Clients | Tabs | Seconds | API CPU % | MySQL CPU % | Paired baseline % | Δ points | SQL / HTTP / errors | Renewals |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 600.001 | 0.0555 | 0.1521 | 0.1243 | +0.0279 | 0 / 0 / 0 | 4 |
| 1 | 1 | 600.001 | 0.0119 | 0.1574 | 0.1286 | +0.0288 | 0 / 0 / 0 | 4 |
| 1 | 5 | 600.001 | 0.0392 | 0.1579 | 0.1259 | +0.0320 | 0 / 0 / 0 | 4 |
| 20 | 0 | 600.001 | 0.1088 | 0.1548 | 0.1247 | +0.0301 | 0 / 0 / 0 | 20 |
| 20 | 1 | 600.000 | 0.1113 | 0.1602 | 0.1307 | +0.0295 | 0 / 0 / 0 | 20 |
| 20 | 5 | 600.001 | 0.1383 | 0.1553 | 0.1247 | +0.0306 | 0 / 0 / 0 | 20 |
| 200 | 0 | 600.001 | 0.4762 | 0.1543 | 0.1250 | +0.0293 | 0 / 0 / 0 | 200 |
| 200 | 1 | 600.002 | 0.4902 | 0.1514 | 0.1228 | +0.0285 | 0 / 0 / 0 | 200 |
| 200 | 5 | 600.001 | 0.4920 | 0.2445 | 0.1931 | +0.0514 | 0 / 0 / 0 | 200 |

Across these nine cells the observed frames were 26,520 transport pongs and 672 compact credential renewals. The business-frame count was zero.

## Project file list and metadata-only edits

The normal OCI entrypoint from `a33ab8501de3d9e02c35846555b7204adca9a6be` used image `c070ffd13ac2333cf5a6621b8ac59b98288be169bc27ada57fe3b7ff58d91c85`. Each cell ran against its own schema on its original CPU pair. The paired references are the preceding MySQL-only 600-second measurements for those same databases.

| Clients | Tabs | Seconds | API CPU % | MySQL CPU % | Paired baseline % | Δ points | SQL / HTTP / errors | Renewals |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 600.002 | 0.0676 | 0.2209 | 0.1243 | +0.0966 | 0 / 0 / 0 | 4 |
| 1 | 1 | 600.003 | 0.0854 | 0.2289 | 0.1286 | +0.1004 | 0 / 0 / 0 | 4 |
| 1 | 5 | 600.002 | 0.0813 | 0.2293 | 0.1259 | +0.1034 | 0 / 0 / 0 | 4 |
| 20 | 0 | 600.001 | 0.1367 | 0.2309 | 0.1247 | +0.1062 | 0 / 0 / 0 | 20 |
| 20 | 1 | 600.001 | 0.1513 | 0.2309 | 0.1307 | +0.1002 | 0 / 0 / 0 | 20 |
| 20 | 5 | 600.001 | 0.1703 | 0.2301 | 0.1247 | +0.1054 | 0 / 0 / 0 | 20 |
| 200 | 0 | 600.001 | 0.6284 | 0.2321 | 0.1250 | +0.1071 | 0 / 0 / 0 | 200 |
| 200 | 1 | 600.001 | 0.6039 | 0.2199 | 0.1228 | +0.0970 | 0 / 0 / 0 | 200 |
| 200 | 5 | 600.004 | 0.5924 | 0.3771 | 0.1931 | +0.1841 | 0 / 0 / 0 | 200 |

The nine runs observed 26,520 pongs and 672 renewals. The captured business-frame count was zero.

## Zero-byte project file upgrade

The API and SPA from `d926b3bdabb99fac4318640e95471286641d66ef` ran as the normal unprivileged OCI entrypoint. Image `cfbbc52e91de3ea9cb3d6e4fa65448a6d06643f9577635741a2617e2e25bc096` ran with release 0.9.195, a private storage volume and database schema per cell. The baseline column reuses the measured MySQL-only interval for the same database and CPU pair.

| Clients | Tabs | Seconds | API CPU % | MySQL CPU % | Paired baseline % | Δ points | SQL / HTTP / errors | Renewals |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 600.010 | 0.0654 | 0.2202 | 0.1243 | +0.0960 | 0 / 0 / 0 | 4 |
| 1 | 1 | 600.001 | 0.0673 | 0.2344 | 0.1286 | +0.1058 | 0 / 0 / 0 | 4 |
| 1 | 5 | 600.003 | 0.0742 | 0.2279 | 0.1259 | +0.1020 | 0 / 0 / 0 | 4 |
| 20 | 0 | 600.001 | 0.1373 | 0.2285 | 0.1247 | +0.1038 | 0 / 0 / 0 | 20 |
| 20 | 1 | 600.000 | 0.1444 | 0.2311 | 0.1307 | +0.1004 | 0 / 0 / 0 | 20 |
| 20 | 5 | 600.001 | 0.1403 | 0.2292 | 0.1247 | +0.1045 | 0 / 0 / 0 | 20 |
| 200 | 0 | 600.001 | 0.6092 | 0.2118 | 0.1250 | +0.0868 | 0 / 0 / 0 | 200 |
| 200 | 1 | 600.001 | 0.6285 | 0.2051 | 0.1228 | +0.0823 | 0 / 0 / 0 | 200 |
| 200 | 5 | 600.001 | 0.6304 | 0.3477 | 0.1931 | +0.1547 | 0 / 0 / 0 | 200 |

Across the nine intervals the probe received 26,520 pongs and 672 credential renewals. The business-frame count was zero.

## Installed 0.9.198 and final MCP authorization

The final API tree `f66fa7dd800cb49e863d031ef2a5dc95d125fe9d` and the signed 0.9.198 wrapper ran through the production Dockerfile entrypoint. Each of the previous wrapper stages also ran the complete nine-cell matrix on separate test schemas. These Linux probes used synthetic communicator identities, the real admin WebSocket and real elapsed time. All comparisons use the measured MySQL-alone baseline for the same CPU-constrained database. An ephemeral loopback-port collision on one intermediate 0.9.197 cell was resolved before its recorded full ten-minute interval.

| Measured revision | Total cells | Lowest–highest application CPU, % of one core | Total pongs | Credential renewals |
| --- | ---: | ---: | ---: | ---: |
| 0.9.196 | 9 | 0.0130–0.5330 | 26,520 | 672 |
| 0.9.197 | 9 | 0.0499–0.5925 | 26,520 | 672 |
| 0.9.198, initial API | 9 | 0.0568–0.6391 | 26,520 | 672 |
| 0.9.198, final API | 9 | 0.0690–0.6107 | 26,520 | 672 |

The final normal image was `sha256:dc12db1c0a949979d9a1f6d29d464a9fd8bc8b0d3ef31d7476c769764f4e2adb`. Each cell below observed zero application SQL operations, browser HTTP requests, browser errors and business frames during the measurement. CPU includes the normal operating environment.

| Clients | Tabs | Measured seconds | API CPU % | MySQL CPU % | Paired MySQL baseline % | Difference (points) | Renewals |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 600.001 | 0.0690 | 0.2258 | 0.1243 | +0.1016 | 4 |
| 1 | 1 | 600.002 | 0.0725 | 0.2304 | 0.1286 | +0.1018 | 4 |
| 1 | 5 | 600.001 | 0.0784 | 0.2250 | 0.1259 | +0.0991 | 4 |
| 20 | 0 | 600.001 | 0.1495 | 0.2259 | 0.1247 | +0.1012 | 20 |
| 20 | 1 | 600.002 | 0.1540 | 0.2334 | 0.1307 | +0.1027 | 20 |
| 20 | 5 | 600.001 | 0.1511 | 0.2226 | 0.1247 | +0.0980 | 20 |
| 200 | 0 | 600.001 | 0.5973 | 0.2151 | 0.1250 | +0.0901 | 200 |
| 200 | 1 | 600.001 | 0.6107 | 0.2040 | 0.1228 | +0.0811 | 200 |
| 200 | 5 | 600.001 | 0.5312 | 0.2671 | 0.1931 | +0.0740 | 200 |

## Release 0.9.200 and the public readiness probe

The production Dockerfile and entrypoint ran product commit `145986062099b6435b92c94fa722c60022539fb6` with the signed test build of cxx 0.9.200. The final OCI image ID was `sha256:9789949c88a8bd68d7add44c6a16775b0870744fd2f37ad8614ea6228aaecd0a`. The normal image served each of the nine independent ten-minute intervals. No application SQL, business frames, browser HTTP requests or browser errors occurred in any final cell. The four native sessions attached in the single-client cohort and their compact authorization renewals are counted separately from transport pongs.

| Revision | Cells | Min–max API CPU, % of one core | Pongs | Compact renewals |
| --- | ---: | ---: | ---: | ---: |
| 0.9.199 | 9 | 0.0289–0.5533 | 26,520 | 672 |
| 0.9.200, receiver correction | 9 | 0.0131–0.6451 | 26,520 | 672 |
| 0.9.200, migration CLI | 9 | 0.0127–0.6358 | 26,520 | 672 |
| 0.9.200, registry and Git scope | 9 | 0.0584–0.5221 | 26,520 | 672 |
| 0.9.200, historical receipt compatibility | 9 | 0.0101–0.5283 | 26,520 | 672 |

| Communicators | Tabs | Real seconds | API CPU % | MySQL CPU % | MySQL alone % | Difference in points | Pongs | Renewals |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 600.002 | 0.0101 | 0.1656 | 0.1243 | +0.0413 | 40 | 4 |
| 1 | 1 | 600.002 | 0.0522 | 0.1795 | 0.1286 | +0.0509 | 40 | 4 |
| 1 | 5 | 600.001 | 0.0342 | 0.1729 | 0.1259 | +0.0470 | 40 | 4 |
| 20 | 0 | 600.001 | 0.1099 | 0.1609 | 0.1247 | +0.0362 | 800 | 20 |
| 20 | 1 | 600.001 | 0.1231 | 0.1702 | 0.1307 | +0.0395 | 800 | 20 |
| 20 | 5 | 600.001 | 0.1075 | 0.1748 | 0.1247 | +0.0501 | 800 | 20 |
| 200 | 0 | 600.001 | 0.5283 | 0.1677 | 0.1250 | +0.0427 | 8,000 | 200 |
| 200 | 1 | 600.001 | 0.5200 | 0.1642 | 0.1228 | +0.0413 | 8,000 | 200 |
| 200 | 5 | 600.000 | 0.5049 | 0.2556 | 0.1931 | +0.0626 | 8,000 | 200 |

The public `/readyz` comparison used the same warm fixture, signed binaries, runner and database. A process outside the container measured six sequential HTTP requests per revision and deltas of the Node process’s Linux `/proc/PID/io` `rchar` counter. This counts bytes returned by read-like system calls, including cached bytes.

| Source | Requests | Median elapsed (ms) | Min–max elapsed (ms) | Median bytes read | Min–max bytes read |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before retained registry | 6 | 382.19 | 312.57–417.06 | 99,817,579 | 99,813,159–99,827,167 |
| After retained registry | 6 | 12.78 | 6.43–20.76 | 253 | 253–261 |
| Final release source | 6 | 8.27 | 6.24–43.48 | 253 | 253–261 |

The original validation constructed a registry per request, causing all five published files to be read repeatedly. The new handler keeps one registry and revalidates its entries when file identity or metadata changes. A separate test atomically replaced a file with the same size and modification time. The readiness response rejected the changed digest. On the old production installation the eight-second Doctor probe sometimes timed out while six checks answered on a separate request. The laboratory comparison isolates the code change. Other production contributors to latency were not measured.
