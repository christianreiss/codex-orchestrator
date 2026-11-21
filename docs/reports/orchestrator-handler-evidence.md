# HTTP handler execution evidence

The [operation table](orchestrator-handler-evidence.tsv) follows the Fastify method/path registrations from the [entry-point inventory](orchestrator-entrypoints.tsv). It distinguishes a registered route, a function body that ran during the aggregate API tests, and the separate wire-level evidence for selected workflows. A positive handler counter can include a rejected input or a direct unit invocation. The [business-flow checks](orchestrator-work-acceptance.md) describe actual transports, authorization, persistence and substituted participants.

## Final aggregate handler evidence

The real MySQL suite ran the API source at `520fe3eefb513ca4bc55f442bef11284eb6e5269`. Its full test totals, native opt-ins, three separate opt-in scenarios and measured coverage are recorded in the [verification report](orchestrator-review.md). The live registration capture supplied 963 method/path pairs. The analysis resolved 629 distinct callbacks and found uniquely attributable positive counters in 41 of them. Other successful operations can be established independently through the [HTTP method and handler trace](orchestrator-http-trace.md).

| Aggregate evidence | Operations |
| --- | ---: |
| ambiguous function line | 100 |
| Positive function counter, one registered operation | 25 |
| Explicit zero function counter | 3 |
| no function counter | 773 |
| plugin no registration line | 3 |
| Positive function counter shared by registered operations | 59 |

| File | SHA-256 |
| --- | --- |
| Entry-point inventory | `73978cd9a5f1b60ffb43e6583fdbddd0b8d4a03fea3d2a607532020daed01cdd` |
| MySQL suite LCOV | `95a33bc85d7cf99c40ffde9ad9a44393d711afb20185d59837ae545429c7a7fb` |
| Handler evidence TSV | `8683d08f852c60124117335ee7d60f60fe72fddaa40e261a28907aff74287a48` |

## Reproduce

From the repository root with the API lockfile installed and the source corresponding to the coverage run, execute:

```sh
node docs/reports/orchestrator-handler-evidence.mjs \
  /path/to/final/lcov.info \
  520fe3eefb513ca4bc55f442bef11284eb6e5269 \
  docs/reports/orchestrator-handler-evidence.tsv
```

The optional admin WebSocket at `/admin/ws` is registered only when `ADMIN_WS_ENABLED` is on. Its ordinary HTTP metadata endpoint is `/admin/ws/info`. The communicator, host daemon, companion and admin sockets use the shared transport.

The generator prints the exact coverage revision, input SHA-256 digests, number of distinct resolved bodies, number entered and totals for each evidence category. It checks each registration and handler file against the supplied Git revision. A differing file is withheld from attribution. For a later run, pass its actual tested commit and complete LCOV file.

## How to read the table

- The registration column locates the API source call from the captured Fastify onRoute stack. TypeScript resolves the actual callback from the positional argument or options object's handler. References can lead to a concrete function or object-literal method in a second file. A factory must return a statically resolvable function. An unresolvable expression remains open.
- The unique body identity is the actual TypeScript node. Where multiple routes, methods or factory instances have the same implementation, the count is the number of registered operations sharing it. `generated-HEAD` identifies Fastify's implicit method registration. A WebSocket flag identifies a callback registered for upgraded connections.
- `body-entered` requires a positive LCOV FNDA, exactly one coverage function on its declaration line and exactly one TypeScript function on that source line. `shared-body-entered` has the same counter requirements but counts the body once across all listed registrations. The suite aggregate cannot identify which alias or HTTP method produced the hit. `body-zero` is an explicit zero for a uniquely identified counter.
- `no-function-counter` means the report contains the source and no function counter on the callback line. The pinned Vitest 2 V8 provider exports named functions to its function map. Anonymous positional callbacks often have no FN/FNDA. `ambiguous-function-line` covers multiple source functions or counters on one line, for which LCOV omits the necessary column information.
- `plugin-no-registration-line`, `registration-not-unique`, `registration-method-mismatch`, `handler-not-resolved`, `source-absent` and `source-changed-since-coverage` describe the missing input or unresolved link. A separate diagnostic column shows the first available direct executable body statement on its own line and its DA count. DA is excluded from handler-entry totals, including when the surrounding registration or boot function is green.

## Manually checked registrations

| Recorded operation | Actual callback and boundary |
| --- | --- |
| GET and HEAD `/healthz` | Both map to `api/src/routes/health.ts:13`. The GET 200 assertion in `api/test/unit/routes/health.test.ts:15` uses Fastify injection. That suite also injects GET readiness with supplied false/true readiness providers. A hit on the /healthz function cannot distinguish the HEAD method. |
| POST `/admin/claude/keys` | The Claude registration passes `keys.create` in `api/src/routes/admin/keys/claude.ts:13`. Its method is in `api/src/routes/admin/keys/gateway-keys.ts:133` and serves four key namespaces. The Claude route-protection suite tests a denied request at the guard. That test by itself gives no evidence of key creation. |
| GET `/v1/models` | The options object at `api/src/routes/v1/index.ts:235` contains a handler at line 237 after the kill-switch, key and backend hooks. Three surfaces register this function for GET and HEAD. A specific GET with a bearer and an asserted payload appears in `api/test/integration/v1/models.test.ts`. The aggregate function counter has no backend or HTTP-method dimension. |
| POST `/companion/v1/approvals/:requestId/approve` | The registration at `api/src/routes/companion/index.ts:524` builds `decide('approve')`. The factory and its returned callback both start at line 509. A named counter at that line could be the boot-time factory; the generator withholds attribution even if the counter is positive. |
| POST `/admin/agent-messaging/chats/manage` | Registration at `api/src/routes/agent-room-chat.ts:133` selects `operation('manage')`; the body starting on line 61 dispatches to `service[name]`. Send, create and manage share that body. A positive aggregate cannot certify all three effects. |
| GET and HEAD `/companion/v1/ws` | At `api/src/routes/companion/index.ts:203` GET registers an upgrade callback beginning at line 211. The transport now supplies a separate ordinary HTTP 404 handler for generated HEAD on WS-only routes. Before the change, an authorized in-process HEAD entered the socket callback once and returned 500. Afterward the same request returned an empty 404 with zero socket dispatches. A real WebSocket handshake via Fastify injection exchanged a message once. Both ordinary methods still passed authorization. The same transport is installed for the admin socket at `api/src/ws/server.ts:26` (admission preHandler, upgrade callback at line 45), `/host/communicator/connect` and `/host/daemon/connect`. See `api/test/unit/ws/transport.test.ts`. |
| POST `/admin/hosts/:id/curl-insecure` | The explicit route at `api/src/routes/admin/hosts/index.ts:632` supplies its own options-object handler at line 636. The service test for curl-insecure overrides before an installer is minted validates a different entry point. The direct deployment-image check below supplies a separate HTTP and persistence result. |
| GET and HEAD `/admin/*`, OPTIONS `*` | The runtime capture confirms these plugin routes without a first-party registration line. Static registration is visible at `api/src/routes/admin/pages/static.ts:68`; the fallback at line 91 is a different function. Neither its coverage nor a Fastify boot hit is credited to the wildcard handlers. |


## Separate HTTP and MySQL acceptance for the host switches

On the isolated API image at `520fe3eefb513ca4bc55f442bef11284eb6e5269`, the integration lead authenticated as the synthetic owner and registered a disposable host. For each POST below, the operator set the value to true and then false. Every response was HTTP 200 and identified the correct host. An independent read of the corresponding MySQL 8.4 column matched both values in each case.

| POST path | Column checked after each request |
| --- | --- |
| `/admin/hosts/:id/roaming` | `hosts.allow_roaming_ips` |
| `/admin/hosts/:id/vip` | `hosts.vip` |
| `/admin/hosts/:id/curl-insecure` | `hosts.curl_insecure` |

The fixture host was deleted and a subsequent SQL count for it was zero. These six requests were sent to the running image in a separate environment. The LCOV function counts in the table come only from the instrumented Vitest run.
