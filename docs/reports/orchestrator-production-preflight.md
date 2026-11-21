# Upgrade rehearsal from the deployed source, 21 November 2026

The deployment inventory identified `11cfc36cd45a9c88f46b94005babaab4200af2e8` as the source previously rolled out. It precedes the review's export by 190 commits. This rehearsal exercises that older API against an independently initialized database on biest.eulie.de. The target API tree is `f66fa7dd800cb49e863d031ef2a5dc95d125fe9d`, present at both `c9e36c886` and `4fa07ab1d`.

| Component | Pinned evidence |
| --- | --- |
| Historical API | API tree `b548db5223bc025c4aa3994e4f442728afd5e2b8`, local OCI image `sha256:982add967d3c2d1865d39013d20f137d1bbf2ee17aec1577c68f86375abe65f6` |
| Candidate API | Local OCI image `sha256:dc12db1c0a949979d9a1f6d29d464a9fd8bc8b0d3ef31d7476c769764f4e2adb` |
| Database and runner | MySQL 8.4.13 on its own Podman volume, real runner image `551496ecf66907563f3df5d233b874fd3c17a2ff8d4656ab5cc1960878d679c8`, Podman 5.8.9 internal network, zero published ports |
| Signing and release | New Ed25519 key generated inside the test storage volume, new 32-byte encryption key passed through process-scoped environment. The historical and candidate Makefiles built all five release binaries with the same new public key, versions 0.9.190 and 0.9.198. |

SHA-256 comparisons between the migration SQL shipped inside each image and the respective Git tree agreed for all 132 historical and 134 target files. The two additions were `0147_remove_usage_scaling.sql` and `0148_agent_session_attachment_generation.sql`.

## Execution record

The historical image's `node migrate.js --init-schema` started against a schema with zero application tables. An initial disposable attempt exceeded the harness's 120-second command deadline during ordinary MySQL DDL. The retried initialization used another empty volume and a 900-second deadline. Timings from this host apply to these small synthetic resources.

| Exercise (UTC) | Observed result |
| --- | --- |
| Historical setup and reads, 21:01–21:07 | The baseline executed 357 statements. Its ledger had 132 migrations through 0135. All six readiness checks passed, including five 0.9.190 wrapper platforms. Through HTTP the old owner established an admin session, completed the wizard, created and revealed an encrypted Secret, registered a Codex host and saved one custom tier using the original `POST /admin/scaling`. SQL found exactly that tier in `versions.usage_scaling_rules`. |
| Stop-before-start, 21:07:08–21:07:11 | The target's read-only inspection identified only 0147 and 0148 as pending, with zero drift. Its write-mode migrator exited 1 while the old API held the database. An independent nonblocking `flock` on the API's actual storage lock returned conflict (73). The old container exited 0 on stop and SQL reported the named owner lock free. |
| Upgrade and repeat, 21:07:11–21:07:31 | Target `node migrate.js` applied 0147 (one statement, 101 ms) and 0148 (ten statements, 823 ms). The container command took 3.26 seconds. Both explicit `--reapply` operations passed, a repeat `--init-schema` performed no work and `--check` reported 134 applied, zero pending, zero drift. SQL confirmed removal of the obsolete key, retention of `hosts.scaling_exempt`, and nullable `INT UNSIGNED` and `VARCHAR(100)` columns on `agent_sessions`. The previous wizard row, the secret ciphertext, the signer ciphertext and public key, and the owner's password hash matched their original values. |
| Application and old client, 21:07:35–21:07:45 | Two successive target owners passed all six readiness checks. The first took 4.22 seconds to respond ready, the second 3.45 seconds, measured from the end of `podman run -d`. The original session cookie still identified its owner. The original Host key fetched a signed config, and the original Secret revealed the exact synthetic value. A real 0.9.190 Linux/amd64 client with an empty private home returned 0 from `codex --status` on both servers. Replacing only the detached signature with an invalid value returned 1 with a signature diagnostic. Both servers used the same signing fingerprint. |
| Historical session retention | A synthetic, already-ended row inserted under the old schema kept its generation and status and acquired two NULL recovery columns through migration and reapplication. The row's explicitly elapsed expiry made it eligible for normal portal retention. The running owner subsequently pruned it. |

## CLI output regression

A successful historical `--init-schema --json` left all 132 ledger entries in MySQL but its piped report ended mid-string at byte 16,384. With a fast reader, a 134-entry status listing could complete even on the affected binary. A regression test used 1,200 explicitly pending fixture files, real MySQL and a slowly consumed process pipe. Before the fix, `--list` exited 0 after emitting 146,176 bytes of invalid JSON. Commit `8f520f081` sets the final exit code and lets Node finish its pending stream writes. The same test then parsed every pending entry for both `--list` (exit 0) and `--check` (exit 1). An invalid option still exited 1 with its diagnostic on stderr. The test uses read-only status queries and never executes the fixture SQL. API typecheck and ESLint for the affected files passed.

The normal root Dockerfile built commit `8f520f081ea266d52e827f350cbdb35f60e996d8`, API tree `078b2a451affd22c6def8a042b21618e9c1db3bd`, into image `sha256:18423a4697be51bdf309a0230ea242ff4d9cdcbe1920038cfb6699d38447619f`. Each OCI test read 134 historical ledger entries and 2,500 temporary pending SQL filenames. The reader delayed consumption for three real seconds. A conventional file was the control.

| Image | `--list --json`, exit 0 | `--check --json`, exit 1 | Control file |
| --- | --- | --- | --- |
| Before the CLI fix | 65,536 bytes, invalid JSON | 65,536 bytes, invalid JSON | 1,257,216 bytes, 2,634 states |
| Patched normal image | 1,257,216 bytes, 2,634 states | 1,257,216 bytes, 2,634 states | 1,257,216 bytes, 2,634 states |

At 21:12 UTC the patched image started on the upgraded database and passed all six readiness checks. The old owner cookie, Secret, wizard state and actual 0.9.190 client remained usable. All three API images used the repository's tini/Node entrypoint for serving and the documented `node migrate.js` entrypoint for migration.

A separate run at 21:19:49–21:20:49 UTC exercised the direct path from the original release to this patched image in a fresh MySQL schema. It again created an owner, a Secret, a host and a custom scaling tier through the historical API. That API reached six green checks at 0.9.190 and released its owner lock before the patched CLI ran. The initial `--check --json` returned 1 with both pending versions. The patched CLI applied 0147 and 0148, explicitly reapplied both, completed a no-op `--init-schema`, and passed `--check` at 134 applied with no drift. These four separate container commands took 6.71 seconds together. The replacement API passed all six checks at 0.9.198. The original admin's session, the revealed Secret value, and the old host's signed 0.9.190 status round trip each passed. SQL still contained the non-expired historical session after the patched owner stopped, with its original generation 7, status `ended` and both recovery columns NULL. The obsolete tier row count was zero.

The first attempt at this additional direct comparison used a shell collector with `&& cat`, which hid the expected report when `--check` returned 1. The successful direct run preserved stdout on either exit code. Its dedicated MySQL data directory was a container tmpfs held throughout both API lifecycles. The earlier rehearsal used a disk-backed MySQL volume. Neither timing estimates production downtime.

## Scope and disposition

Both test installations used synthetic data, newly issued credentials and internal-only networks. There was no production connection, database dump, backup, customer transcript, provider login or real account refresh. No active paid session or production-sized DDL load was simulated. The native client actually executed here was Linux/amd64 0.9.190. Readiness checked artifact metadata for the other four platforms. The .198 to .199 wrapper acceptance uses a separate release fixture. Production must retain its own encryption and signing keys and follow the [stop-before-start cutover procedure](../owner-cutover.md).

The test API, runners, MySQL containers and data, signer storage, test networks, compiled wrapper fixtures and task-local patched image were removed. Process and Podman resource listings confirmed the absence of `orch-prodsource-*` resources. The two source images supplied to the test were outside the fixture's ownership. Sanitized command results, timestamps and comparator output remained available to the integration owner under `.review/production-upgrade/probe/` at handoff (`events.json`, `events-direct.json`, `cli-regression-before.log`, `cli-regression-after.log`).
