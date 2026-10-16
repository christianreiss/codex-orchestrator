# Communicator audit: Elvira, 2026-10-13

The independent audit started from `comm` at
`8737430d55e58c70be2050d0d9bd0fc3cbca2651`. Fixes were made in a linked
worktree, committed and integrated through Git Director leases. The first VM
regression snapshot was `48b1aceb1305927526b2efec6721d49f6df95dce`, cxx 0.9.74.
Authenticated native acceptance used `45c82b382a044175ac57d281fbb5cc8c20033553`,
cxx 0.9.75, including subsequent socket, outage, daemon and idle-owner fixes.
All three engines were reviewed together; component responsibilities were not
divided between reviewers.

## Transport inventory

| Traffic | Implementation and verified boundary |
| --- | --- |
| Codex/Claude/Grok managed startup, content, auth and account leases | Persona orchestrator clients use `communicator.Wrap`; finite workers reuse their existing engine writers and account/session binding. Grok keeps server-owned refresh and its private readiness broker. |
| Fleet MCP tools | `cxx communicator mcp <engine>` uses signed endpoint selection and the shared socket. Six real adapter processes, two for each engine, share one control connection. |
| Peer messages, calls, conferences, receiver and operator portal | Agentbus and portal HTTP clients wrap the same transport. Session-scoped bridge and relay tokens remain independent. |
| Persistent host daemon | `DialDaemon` multiplexes the existing daemon protocol over the control connection. Overflow and disconnect fencing isolate this stream from other engines. |
| Downloads, attachments, large bodies and watchdog streams | The communicator owns separate HTTPS transfers. Route and header checks retain the signed host identity, including normalized trailing-slash MCP paths. |
| Repair while the owner is unavailable | Only verified signed-config and wrapper binary download reads can bypass a failed local owner. Other managed calls, including wrapper metadata, fail closed. |
| Native provider inference and provider CLI installation downloads | Keep their existing provider connections; these external services are not the orchestrator control transport. |

## Fixes and corroborating source

Elvira's `d160b50b` pins HTTPS transfers to the signed host key, strips cookies,
forwarding headers and replacement credentials, blocks non-managed routes,
checks large MCP uploads against the same host, adopts signed transfer policy
on reconnect, and fails closed on unsafe runtime directories. Failing Go and
API reproductions preceded the fix. `148bcb0f` aligns transfer routing and MCP
binding with the router's trailing-slash behavior.

Other independently produced fixes were inspected and preserved during
integration: logind runtime-root convergence (`0d57ccce`), correlated MCP
unknown outcomes (`bacd2dd4`), daemon overflow isolation (`8a61a299`), API frame
isolation and trailing-slash normalization (`69c49491`), verified repair reads
(`fd3eacca`), and daemon disconnect/reattachment fencing (`866eb2a4`).

## Executed checks

- Host: full Go race suite, `go build ./...`, `go vet ./...`, clean `gofmt -l .`,
  and `make test`, including release manifest and publication tests.
- API: the final combined plain tier passed 4,659 tests, with 627 tests skipped in the plain
  tier; typecheck/build passed and lint had zero errors. The final focused API
  communicator and MCP credential suite passed all 47 tests after integration; adding config rendering brought the focused tier to 125 passes.
- Frontend: final `svelte-check` reported zero errors/warnings; 928 tests passed.
- Real MySQL: disposable MySQL 8.4.11, explicit isolated connection, baseline
  applied and all 62 migrations applied by the repository runner. The full tier
  ran 1,387 tests: 1,385 passed and two timing fixtures failed. After correcting
  those fixtures, the complete companion file passed 21/21 and the board
  renewal regression passed against the same real database.

Each of the three Debian 13 VMs ran the same command as its own unprivileged
test user with Go 1.25.13, a private runtime directory and module cache:

```sh
go test -count=1 -v ./internal/communicator \
  ./internal/persona/codex/lifecycle \
  ./internal/persona/claude/lifecycle ./internal/app/grok
```

| VM | Verified address | Communicator | Codex lifecycle | Claude lifecycle | Grok application |
| --- | --- | --- | --- | --- | --- |
| test1 | 10.2.0.213 at native acceptance; 10.2.0.215 after reboot | Passed | Passed | Passed | Passed |
| test2 | 10.2.0.212 | Passed | Passed | Passed | Passed |
| test3 | 10.2.0.214 | Passed | Passed | Passed | Passed |

Every VM process fixture reported one initial control connection for six MCP
clients, three connections total after remote disconnect and owner crash, and
successful post-recovery calls. Thirty concurrent content callers shared seven
engine operations and preserved native credentials. Signed key rotation,
unknown outcomes, socket permissions, auth recovery, rollback and stream
isolation regressions passed. VM checks use CGO disabled; the race detector ran
on the source host separately.

The initial VM archive omitted `wrappers/testdata`; only the Grok fixture file
lookup failed. The corrected archive included the complete wrappers tree, and
all four suites passed on all three VMs. Go toolchain hashes were compared
before execution; the corrected source archive hash was confirmed afterward
on every VM: `8dcd84570cead4f8d60d611238140b8bbc99589022393f21e0c6ec397c431054`.
Full VM logs remain at
`/opt/coco-comm-audit-elvira/tests-final.log`; local copies are
`/tmp/elvira-comm-test{1,2,3}-final-full.log`.

## Database fixture findings

The first full DB run exposed two existing timing assumptions outside the
communicator: a one-second initial companion subscription wait, and a board
claim expiry rounded to whole seconds while real MySQL commits consume the
remaining fraction of a second. The corrected tests retain the actual delivery
and renewal assertions: the subscription uses its existing ten-second bounded
delivery budget, and the board test injects a stable business clock. Both
retests passed. Selecting only the companion activity test also exposed its
dependency on the pairing performed by an earlier test, so its entire file
was rerun rather than counting a filtered run as success.

## Authenticated native acceptance

All nine fresh provider-authenticated sessions completed with their requested
`COMM_TEST<n>_<ENGINE>_OK` marker and called the fleet `agent_self` tool. The
canonical UUID/name pairs were independently read back with `agent_translate`.
The tasks requested no peer messages, shell commands or project edits.

| VM | Engine | Name | Canonical agent UUID |
| --- | --- | --- | --- |
| test1 | Codex | Sarah | e43416b2-a5ed-43ad-9d58-8bb23e76f10a |
| test1 | Claude | Margitta | 137d7f2e-4f5f-4b6a-8a3e-0111be32e2f4 |
| test1 | Grok | Catrin | b182fda9-950e-42cd-9865-fd45b0356edc |
| test2 | Codex | Ulla | 55ff6c1a-3f7a-4448-9233-f0578fb25211 |
| test2 | Claude | Lynn | 2aa060b7-5221-40ef-bd7c-222417df5b41 |
| test2 | Grok | Ann-Lena | 3e57742c-6756-421f-8e10-fcd682d5e0bc |
| test3 | Codex | Jeannette | 68ff9240-b991-4593-8b99-4499545eca80 |
| test3 | Claude | Suzanne | 0d51fb0b-060b-48ea-886a-2c2d2c5858d3 |
| test3 | Grok | Melanie | 21f4f137-094c-4466-bb41-74fd103986ca |

Installed native versions: Codex 0.162.1, Claude Code 2.1.296, Grok 1.0.50.
Final communicator doctors exited zero on every VM, with version 0.9.75,
`connected: true`, `https_fallback: false`, empty transport/local errors and
successful content sync. The private owners handled 155, 178 and 154 requests,
respectively, at the final native check, with independent identities and auth
scopes. These checks used the existing compatible live API; the changed API
dispatcher and MCP guards were exercised by local Fastify and database suites.

VM setup used the dedicated `comm-elvira-ca1fb4ad` account and private
`/opt/coco-comm-audit-elvira` installation on each machine. test1 and test3 were
registered through System Spawn as hosts 257 and 258; test2 reused its existing
registration and signed configs without changing its root credentials or
processes. The guest hostnames now match test1/test2/test3.eulie.de. The new
users' logind buses and lingering were enabled for the receiver service.

The first unprivileged installer run on test1/test3 returned incomplete because
there was no user bus, despite installing all three native CLIs. Enabling the
private user bus and rerunning bootstrap resolved it. test2's first Codex
execute was refused after only copying signed host configuration; explicit
credential sync seeded its separate native home and the retry passed. A
root-owned cron schedule on test2 was preserved; its per-user bootstrap's
attempt to reconcile that schedule reported insufficient sudo rights, while
all native launches and communicator health checks succeeded.

Old task-owned 0.9.73 owners did not exit after SIGTERM during upgrade. They
were identity-checked and stopped with pidfds before any native smoke session
started; peer/root owners and native sessions were preserved. The subsequent
idle-owner fix is included in the tested 0.9.75 snapshot. Codex also emitted
its native memory-baseline diagnostic in the non-repository smoke directory;
its inference and fleet tool calls nevertheless completed successfully.

The final audit found one more cross-layer error case: a route could complete
and then produce an oversized control reply. The adapter initially reported
`outcome_unknown: false`. A failing reproduction preceded the correction;
the adapter now preserves the size error code and requires verified readback
before retrying the completed call.

## Acceptance boundaries

The process regressions use controlled upstream services and test credentials;
the separate native matrix above proves provider inference and fleet identity
calls. No production API restart, wrapper publication, provider auth
rotation or push was performed by this audit. Existing production/native
sessions were left running.

Findings and commits were sent to all available review peers and the
coordinator. A queued delivery was not counted as a peer acceptance or reply.

The final source also incorporates the peer bakery URL, socket-close, idle-owner,
scoped lease-wakeup, host-scoped reply and topology fixes. The full combined Go
race suite, API typecheck/build/lint and frontend checks passed. Task commits
made after the signing agent timed out used an explicit per-command unsigned
override; the existing repository signing configuration was not changed.

## Final 0.9.76 repeat

The final transport snapshot `57173c6662abce48c502a23a8f64b000f226242c`
passed a fresh full Go race/build/vet run and API typecheck. The affected API
communicator and MCP credential tests passed 49/49. Each VM again passed all
four communicator/Codex/Claude/Grok suites against this snapshot. The subsequent
`f89fc864a6a7a33fdfc4fc6578a297c74767ba1f` change only improves the refusal
diagnostic for an unresolved auth upload; both engines' lifecycle and
orchestrator race suites passed after independently reviewing that change.
The final caller-retry regressions from `0aa3810b` were also reviewed and
passed independently with `go test -race -p 1 ./internal/communicator
-run '^TestCallerRetry' -count=1 -timeout=90s`.

The identical private cxx 0.9.76 binary installed on all three VMs has SHA256
`70d49a28164919d6b01fd62fc6dfcfba2cb697680c020ce8e199a56795a35259`.
All nine native launches completed with their requested `COMM_076_TEST` marker
and a fleet `agent_self` call. Server `agent_translate` readback confirmed each
returned name and UUID:

| VM | Engine | Name | Canonical agent UUID |
| --- | --- | --- | --- |
| test1 | Codex | Brunhilda | e1014956-c7e3-49d1-b526-18ae14d13634 |
| test1 | Claude | Annabella | 9c12bd02-f895-4d2b-a483-5d98dc8a535a |
| test1 | Grok | Cassandra | 0158c665-87de-42d7-bfb2-633a973be0e5 |
| test2 | Codex | Anne-Kathrin | 4a995705-32fe-41b2-8e8a-ca6699b11e2b |
| test2 | Claude | Antonie | f72e5a2c-467c-431c-a815-1e6eb77f676f |
| test2 | Grok | Margarete | 8a562bd9-900d-492f-9dbb-0fda93bf91f6 |
| test3 | Codex | Vivien | b1ecb062-ccaa-43e2-acfc-583d04a41300 |
| test3 | Claude | Irma | 62aa8b1c-1e74-49a4-bf1c-be81aa880382 |
| test3 | Grok | Heidrun | 4d3d6ead-d93a-4b6a-b8c8-52e327b196c2 |

Final doctors exited zero: `connected: true`, `https_fallback: false`, empty
transport/local errors, with 140/137/136 requests on test1/test2/test3.
Logs remain under `/opt/coco-comm-audit-elvira/` on each VM:
`final-076-tests.log`, `native-076-{codex,claude,grok}.log` and the preparation
logs. The first interrupted Codex/Grok attempt is preserved separately.

Two test-environment issues were resolved before accepting this repeat.
test1 rebooted onto DHCP address 10.2.0.215 instead of 10.2.0.213; releasing only
test host 257's IP binding through the admin endpoint allowed the next real
sync to bind the new address while retaining secure mode. Also, my manual
private binary upgrade started the service without refreshing its deployment
hash. The first native launches then triggered the normal service update,
interrupting accepted sync and correctly producing unknown outcomes and auth
markers. The supported `cxx agent service install` completed preparation;
`cxx codex sync` reconciled and cleared the markers against verified matching
server credentials. No credential file was discarded, and no auth upload was
blindly replayed. The affected Codex/Grok launches then passed on every VM.

## Combined owner-control acceptance

The final combined runtime source is `6345db38f029c748217f86a081417b26e69470b8`,
including the console owner-stop feature from `0236049c`, the refusal diagnostic
and caller-retry regressions. Independent checks passed: full Go race/build/vet,
API typecheck plus 135 transport/topology/credential/authorization tests,
frontend check with zero Svelte errors/warnings and 928 unit tests, and all
eight Playwright topology tests against a freshly built SPA. The browser cases
cover permission gating, acknowledged/unacknowledged termination, keyboard
operation and accessibility. Controlled process tests verify real owner exit
and replacement without signalling the native clients; the production API's
owner-stop route was not deployed or invoked by this audit.

All three VMs passed the same four communicator/engine suites again, including
the new control process tests. Each then ran all three authenticated native
engines again with the exact combined binary. All nine exited zero and returned
their requested marker and fleet identity. Server identity readback confirmed:

| VM | Engine | Name | Canonical agent UUID |
| --- | --- | --- | --- |
| test1 | Codex | Lore | 63f92948-5c2c-455b-ab91-619ee61a23f7 |
| test1 | Claude | Ute | aaab351f-3d09-48e1-a837-abb7af9bd17b |
| test1 | Grok | Ingetraut | 507000b8-4df7-4330-8ae8-20aa7074a0f8 |
| test2 | Codex | Gunhild | 917d3661-5d31-4206-aae9-f8a60d67244c |
| test2 | Claude | Eva-Maria | 44f82e61-c747-49e4-a267-9721bb2fdab7 |
| test2 | Grok | Alwine | d1b86c8b-bfd8-4b23-b32c-4b5bf1338543 |
| test3 | Codex | Dania | 3b6cf223-6f4c-4e91-94c3-10c0c02d8832 |
| test3 | Claude | Ivana | 15296dd4-3f19-4b70-a1f9-b573b6a5c437 |
| test3 | Grok | Hedda | 10f09742-c8ef-4212-85f0-7c5a3567e498 |

Installed binary SHA256 on every VM:
`4c17142deee8f1171eb663c3b7c863e96bf0b909412bb262f13d1481f6d5e994`.
The `native-076-{codex,claude,grok}.log` files now contain this final run and
identify its source commit; earlier successful logs are preserved as
`native-076-57173c66-{codex,claude,grok}.log`. The new VM process evidence is
`owner-final-tests.log`.

The final repeat also captured nonfatal portal-finalization HTTP 409 warnings
on test3 and unknown background Grok auth outcomes on test1/test2. The owners
stayed running and reconnected; all nine native results succeeded. The two
ended private broker scopes retained their errors for the implementation's
five-minute diagnostic interval. This is historical scope state rather than
proof of a currently broken account, and the audit did not discard it or
restart an owner to hide it. The precise upstream interruption was not
established by these measurements.

Normal pruning subsequently cleared the ended scopes on all three VMs.
`doctor-owner-pruned.json` records exit zero, connected control, no HTTPS
fallback and empty errors on all three, at 148/153/126 requests. Owner PIDs
8349/25069/21071 were unchanged; no restart or manual error clearing was used.

## Follow-up: recovered and custom config command routing

Dorothea's earlier G1/G2/G3 review arrived after the acceptance above. G3's
seed-removal fix in `467974da` passed an independent race-enabled rerun of
`TestSelectSignedConfigKeepsHostBindingAndEnabledScope` and
`TestProcessesShareConnectionAndRecover`. G2's restricted repair reads and
nonblocking HTTPS transfer regressions also passed.

G1 still had a narrower command-dispatch gap on `d2371b30`: the real Codex and
Claude `status` commands sent one direct auth request and zero communicator
requests after either expired-config recovery or custom `--config` selection.
Grok passed both cases. The new `TestRecoveredAndCustomConfigsRouteEveryEngineStatus`
reproduced all four failing cases before the fix. Binding the verified config
immediately after `LoadOrRecover`, before either app dispatches commands or
constructs clients, closes the gap for status, auth helpers and startup repair.
Native lifecycle binding remains in place for direct lifecycle callers.

The full Go race suite, build, vet and canonical `make test` passed with the fix.
The six-case regression also passed as private real wrapper processes on each
of test1, test2 and test3 (18 cases total): zero direct control requests, at
least one communicator request, and exactly one signed repair fetch per expired
config. The fixture uses controlled upstream services and stub native version
commands, not provider inference. It does not replace the nine authenticated
0.9.76 acceptance receipts above with a claim about a later native binary.

VM test source remains in `/opt/coco-comm-audit-elvira/src-recovery`, with
`/opt/coco-comm-audit-elvira/recovery-tests.log` on each VM. Source archive SHA256:
`f9efff2698f1e2d785c60832325c37630ef52f0191c3e5f18498918d8710e66f`.
All temporary test owners were stopped; installed binaries, receiver services
and peer sessions were unchanged. Host logs are
`/tmp/elvira-comm-recovery-full-go.log` and
`/tmp/elvira-comm-recovery-make-test.log`.
