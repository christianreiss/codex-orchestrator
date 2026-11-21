# OAuth connector acceptance, 2026-11-21

The local connector accepted an OAuth public client, enforced consent and returned the expected service results for all 22 advertised tools. Before the fix every otherwise authorized delegation failed. Commit `3b8a9ad20` restores delegation as durable work. External provider applications, public TLS ingress and a real provider CLI are outside this local proof.

## CON-001 · High · Fixed and verified

On the initial API build, an owner authorized delegation to a selected host and its attached, execution-capable synthetic session. The standard MCP call returned JSON-RPC `-32602`. A separate diagnostic rerun observed the queue validator's rejection of coordination delivery for work. In `api/src/services/connectors/catalog.ts`, the connector explicitly passed `kind: request` together with `deliveryClass: coordination`. The external bridge already supplies `information` and `after_turn` when the class is omitted.

Removing the overriding argument preserved the required capability, explicit delegate grant, recipient scope and queue validator. Real MySQL contained one attributed request after retry with the same client message ID. Acceptance left its result list empty. Only the receiver's explicit success populated the result. Removing the right after enqueue and before claim prevented delivery. This scenario used exclusively synthetic messages. The test receiver itself provided the reported observation.

## Tool inventory and live authorization

One grant was issued to an owner with all categories, a single allowed host, two named projects, explicit global scope and all four sensitive permissions. A separate viewer requested the same grant. Each row identifies its strict role capability, the additional scope and the observed effect. The viewer column records presence in that viewer's actual `tools/list`; all rows were called with the owner grant.

| Tool | Strict capability | Category and grant required | Viewer | Observed effect |
| --- | --- | --- | --- | --- |
| `hosts_list` | hosts.read | hosts, named host | yes | Listed only the selected host out of two created. |
| `projects_list` | projects.read | projects, named projects | yes | Listed exactly the two approved projects. |
| `project_read` | projects.read | projects, named project | yes | Read the changed summary. An excluded project was denied. |
| `project_update` | projects.manage | projects write, named project | no | Changed a summary. After policy reduction, the attempted change was rejected and the previous summary persisted. |
| `project_delete` | projects.manage | projects write, named project, delete | no | Removed the disposable project from subsequent listings. |
| `project_notes` | projects.read | projects, named project | yes | Returned the saved note body. |
| `project_note_write` | projects.manage | projects write, named project | no | Created the note under the selected project. |
| `workflow_list` | workflows.read | workflows, global | yes | Listed a real workflow ID created through its admin API. |
| `workflow_get` | workflows.read | workflows, global | yes | Returned the expected definition title. |
| `feedback_list` | feedback.read | feedback, global | yes | Found one entry after duplicate submission. |
| `feedback_submit` | feedback.manage | feedback write, global | no | Submitted the same feedback twice with the original request ID. |
| `skill_read` | content.read | content, global | yes | Returned the synthetic manifest body. |
| `skill_write` | content.manage | content write, global | no | Stored the manifest under a new slug. |
| `skills_list` | content.read | content, global | yes | Found that slug after writing. |
| `shared_memory_list` | memory.read | memory, global | yes | Returned the new shared-memory entry. |
| `shared_memory_read` | memory.read | memory, global | yes | Read the original and revised bodies. |
| `shared_memory_write` | memory.write | memory write, global | no | Created an entry, then replaced it using the previous SHA-256. |
| `secrets_list` | secrets.read_metadata | content, global, secrets.metadata | yes | Returned the synthetic slug. The synthetic value was absent. |
| `secret_reveal` | secrets.reveal | content, global, secrets.reveal | no | Returned the expected synthetic secret. Removing the sensitive right denied it immediately. |
| `agents_list` | agent_portal.read | coordination, named host | yes | Listed the selected host's session and denied the other host. |
| `agent_delegate` | agent_portal.manage | coordination write, named host/session, delegate | no | Queued a durable request. Retry returned the original message. |
| `work_result` | agent_messaging.reveal_content | coordination, originating grant and permitted host | no | Returned queued/accepted with empty results, then the receiver's explicit result. A separately issued owner grant could not read it. |

The management catalog and the full owner's advertised tool names matched exactly. The viewer saw 13 tools, could consent to its own connection, could read its own grant list, and could revoke its own grant. It could neither change connector policy nor revoke another user's grant. A separate two-tool owner consent remained limited to `hosts_list` and `project_read` after a ceiling reduction and subsequent restoration.

## Protocol and persistence

Two independently bound HTTPS origins on loopback acted as the resource server and public client callback. The client trusted the fixture certificate and performed normal certificate verification. The TLS listener forwarded requests to the built Fastify server on a third loopback port. Setup used the normal owner claim, host registration, dashboard login, admin feature configuration, project/workflow creation and host session routes. An actual communicator WebSocket carried the synthetic session/receiver attachment.

- Both metadata documents identified the configured issuer/resource and S256 support. A host key presented to the connector returned HTTP 401 with the protected resource metadata challenge.
- Public client registration, authorization redirect, session-bound consent, per-request CSRF token, callback state/issuer, S256 code exchange and replay rejection ran over HTTP. A denied consent reached the client with `access_denied`; an anonymous consent read returned 401.
- With a live bearer, removing project writes and secret reveal from the ceiling changed discovery and blocked both operations. Refresh rotated both tokens. Reusing the old refresh token invalidated the grant; explicit revocation rejected both further resource access and refresh.
- A narrow grant remained usable across a clean owner-process shutdown, restart and rehydration of the same isolated MySQL database. Disabling the provider invalidated existing grants; re-enabling it required reconnecting.
- A loopback client completed public client registration, authorization, a scoped tool read and revocation for each of the four supported provider labels. The 22-operation sweep used the ChatGPT label. No request went to a provider cloud or resolved a remote client metadata document.

## Reproduction and scope

Host `biest.eulie.de`, Node.js 22.22.2 and MySQL 8.4.13. Input checkout `d9ad8e285`, initial API bundle SHA-256 `ac5a0cb397d6cab2f2198783b672c761e6d707de3ac2fb79300f54cd5d22c691`; first repaired bundle `bed141a618d820f668e78dcb6555c12f50f8e4db252e2fce5ad6715604029a75`; final full sweep and its owner restart both logged `f91d088975101e8083e8260962ab9e8c438cb1892de2076b6295017607688226`. Full system evidence came from the built API over actual loopback sockets and a private database. The broader 22-tool client is in the ignored worktree evidence directory `.review/connector-acceptance/`. Its log contains check labels and tool names. Every invocation created fresh credentials and its own schema and removed them at teardown. No fixture schemas or listeners remained after the final sweep.

The maintained regression uses the production Fastify composition through in-process HTTP injection and actual MySQL. It verifies the durable row, its grant association and queue policy, stable replay identity, and the absence of a premature business result. A separate setup hook accommodates cold database provisioning; the business assertions retain a 60-second limit. From `api/`, with the repository's disposable MySQL test environment:

```sh
npm run build
npm run typecheck
node_modules/.bin/eslint src/services/connectors/catalog.ts test/helpers/test-db.ts test/integration/connectors/agent-delegate.test.ts
TEST_USE_DB=1 node_modules/.bin/vitest run test/unit/connectors test/integration/connectors/agent-delegate.test.ts --no-file-parallelism
```

All four commands passed. The focused Vitest run passed 19 cases across three files. The separately tested OAuth owner suite already covered MySQL grant hydration and token storage. Browser interaction with the consent form, connectors hosted in provider clouds, external metadata retrieval and native agent execution belong to different validation boundaries.
