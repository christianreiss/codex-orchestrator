# Operator MCP, resource, Git Director and schedule acceptance

The integrated API at `ee85552733a1edd7d388e3d44bb70bf4c4fbc10e` passed the fourteen checks below on 2026-11-21. The process used Node 22.22.2 on Linux, its normal built entrypoint and MySQL 8.4.13. The operator client used HTTP JSON-RPC at `POST /mcp`. Three synthetic sessions used the normal host and bridge routes and the communicator WebSocket. Neither the MCP dispatcher nor the store, owner, workers, clock or filesystem was mocked.

| Surface | Test and observed effect |
| --- | --- |
| Operator identity | A registered host saw none of the six `fs_*` tools. Its direct call received JSON-RPC `-32601`. An operator bearer alone received HTTP 401 `invalid_mcp_credential`. Adding the valid host key exposed all six. |
| Filesystem | `fs_file_exists` observed absence, then presence after `fs_write_file`. `fs_read_file` and an independent OS read agreed on the bytes. `fs_stat` returned their length. `fs_list_dir` listed the file and `fs_search_in_files` found its matching line using a root-relative include pattern. Replacing the contents changed the same file on disk. |
| Filesystem configuration | The same operator and host queried a restarted API with `MCP_FS_ROOT` unset. Discovery contained zero filesystem tools. The direct filesystem call was refused. |
| Shared resource | `resource_create`, `resources/list` and `resources/read` round-tripped a `shared://` document. Updating with a stale digest returned `shared_memory_conflict`. With the actual content digest the update succeeded, another host read the revision, and deleting it made the read fail. |
| Project resource | A synthetic project received a `project://…/memory/…` resource through `resources/create`. Both `resource_read` and a second read following `resources/update` returned the requested content. `resources/delete` removed it, then `project_archive` retired the fixture project. |
| Host resource | Two hosts used the same `memory://` URI. The second initially read `missing` and then created its own value. Updating the first left the second value intact. Deleting the second left the first intact. |
| Persistence on restart | The same two credentials saw the first host's updated content and the second host's missing record after owner restart. Deleting the first value then produced `missing` for it too. |
| Schedule management | Host A created a disabled interval schedule. Host B listed it and enabled it under its current version. The API rejected a stale revision with `schedule_version_conflict`. Deletion under the current revision set `enabled=0` and `deleted_at` in MySQL. This fleet-wide management is documented behavior for eligible hosts. |
| Offline schedule | A real one-time deadline elapsed while its target lacked a connected receiver. MySQL contained exactly one `waiting` run with a null message ID. |
| Receiver arrival and cancellation | The target completed receiver registration under its bridge and opened a receiver state stream. The same run became `queued` and acquired a message ID. Deleting the schedule before acceptance set the associated bus message to `canceled`. |
| Git identity | Registration without the live native instance failed. Host B presenting host A's session binding received HTTP 403 `agent_bridge_host_mismatch`. Opening the native session stream with the correct host and bridge admitted registration with connection ownership. |
| Git lifecycle | Repeating registration preserved the worktree ID. The client joined and listed the synthetic clone, requested a merge lease, retried its request UUID and obtained the same request ID. It polled status, released the lease and deregistered the worktree. MySQL confirmed retirement. |
| Two sessions contending | Session B registered a separate synthetic checkout under the same declared Git common directory. Its request waited while A held the target branch. Replaying B's request retained its ID. After A released and deregistered, B obtained `allow` for that request and released it. The clone had exactly two merge-request rows. |
| Protocol 1 claims | With scope coordination enabled, an attached session advertising scope protocol 1 could register but could not obtain a merge lease without its path and branch claims. Acquiring both under one request UUID and replaying it returned one active claim ID. Retrying the same merge request obtained `allow`. Both the registration and claim were explicitly released. |

## Evidence and boundaries

The run initialized a fresh database with `node dist/migrate.js --init-schema`, bound `node dist/server.js` to loopback, then created an owner, persisted the Codex fleet default and registered two hosts through the HTTP API. The synthetic checkouts were absolute path declarations in the private lab. No repository or remote existed at those paths. The lease check exercised coordination through the server; it performed no Git or provider operation. The schedule test stopped at durable cancellation of an unaccepted item. Execution of a provider turn, persistent recovery, native CLI behavior and an actual merge require separate evidence.

The tested server artifact had SHA-256 `ac5a0cb397d6cab2f2198783b672c761e6d707de3ac2fb79300f54cd5d22c691`. The worker issued and resumed the scheduled run on wall-clock time. The complementary Vitest run passed all 131 tests in the following five files, including the existing filesystem-boundary checks, Git owner model and MCP route fixtures.

```sh
cd api
npx vitest run --no-file-parallelism test/unit/services/mcp-fs.test.ts \
  test/unit/services/mcp-resources.test.ts test/integration/mcp/jsonrpc.test.ts \
  test/control-plane-state-git.test.ts test/unit/services/schedules.test.ts
```

The private harness was invoked as `node .review/operator-mcp/lab.mjs` with the disposable database credential supplied in the process environment. Every invocation dropped its uniquely named schema and removed its private storage and filesystem root in a cleanup handler. The successful run also closed the synthetic sessions and stopped its two API process lifetimes. The port, schema prefix and temporary directories were checked separately after exit.
