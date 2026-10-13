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
| Repair while the owner is unavailable | Only verified signed-config and wrapper metadata/download reads can bypass a failed local owner. Other managed calls fail closed. |
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
- API: 4,594 tests passed, 621 database-dependent tests skipped in the plain
  tier; typecheck/build passed and lint had zero errors. The final focused API
  communicator and MCP credential suite passed all 47 tests after integration.
- Frontend: `svelte-check` reported zero errors/warnings; 906 tests passed.
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
| test1 | 10.2.0.213 | Passed | Passed | Passed | Passed |
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
