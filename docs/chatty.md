# Chatty

Chatty is the personal product assistant in the authenticated Admin WebUI.
The speech-bubble character opens a responsive conversation at the bottom right.
Owner and Admin may use it, including in compatible authorization mode. Other
roles cannot call its endpoints. Login, setup, the agent portal and Android do
not mount the widget.

## Availability and controls

The first appearance requires an enabled engine, an enabled provider account
with positively verified canonical auth, an enabled model and a reachable runner
advertising Chatty protocol 1. An issued gateway API key is not upstream access.
The quota hard-fail policy is checked both for availability and the leased account.
After first availability the character remains visible when unavailable.

Automatic selection uses the configured engine order (Codex, Claude, Grok by
default) and keeps the last successful engine within a request. Transport/provider
failures may fall back to the next usable engine; manual selection never silently
changes engine. Replies identify the engine and model. Grok refresh uses the
existing centralized owner; all runner homes contain access-only projections.

Engine and model selection use compact buttons in the chat: Automatisch follows
the configured engine order, and Standardmodell follows the selected engine’s
default. The selected choice is highlighted. Model buttons scroll horizontally
when needed; selection is locked during active work. Minimize, stop and new chat
also live in the chat. The trash button
starts a new conversation with one click, without confirmation, and focuses the
empty message field. Enter sends;
Shift+Enter inserts a newline. The settings card on `/admin/settings#chatty`
controls availability, engine priority and concurrency. Deactivation stops active
model calls. The API kill switch also suspends the worker.

One conversation belongs to each admin account across tabs, browsers, devices
and logins. Closing the panel does not stop work. Clear deletes the conversation
and pending actions everywhere, advances a generation fence and cancels work.
It does not undo completed administrative changes. Content-free request ID/hash
tombstones and ordinary domain audit records remain.

## Knowledge and tools

Builds generate `dist/chatty-knowledge.json` from maintained interface and product
documentation, shipped manual articles, current MCP tool definitions and the
Chatty tool registry. Docker copies these inputs into the build stage. The private
artifact has a corpus digest and per-source path, heading and digest; it is not
a public static asset. Runtime source reads require Chatty access. Development
can build the same corpus from the checkout.

The maintained source set includes installation and security guides, all engine
interfaces, communicator and owner/recovery contracts, Android, workflows,
coordination, file transfers, and component READMEs. Dated audits and design
proposals are excluded from the default corpus. Both Dockerfiles require the
repository root as build context (`docker build -f api/Dockerfile .` for the
API-only image), so they receive the same knowledge inputs.

`npm run build` in `api/` regenerates the artifact from the current files. The
running coordinator caches its loaded bundle: editing Markdown alone does not
refresh an existing process. Deploy the rebuilt API image and recreate the API
to activate a new corpus. `GET /admin/chatty/status` reports `knowledge_version`;
compare it with the generated artifact's `version` when verifying a rollout.

Weighted term search discounts common terms and expands German product aliases.
There is no embedding service or external index. The model can search and read
sources; only source IDs actually retrieved during the run become citation cards.
Documentation describes contracts. Live domain tools provide installation state.
Page context contains only a route and optional typed entity identifier; the server
loads its state. No DOM, query strings, unsaved forms or browser storage are sent.

Tools expose strict argument schemas and call domain services directly. The
registry covers hosts, provider accounts, engine switches, models/configuration,
skills, fleet instructions, Claude artifacts, projects, notes, board cards, shared
memory, users, gateway-key state, metadata, schedules and watchdog suspension.
It also reads workflow runs and manages workflow definitions, agent roles and
proposals, fleet/account quota policies, quota advice/scaling, server retention,
and fleet supervisor configuration. Supervisor diagnostics and pause controls
are available; no tool launches an agent or enables individual task recovery.
These administrative mutations require a prepared target snapshot and explicit
confirmation. A cleanup receipt confirms admission of a guarded asynchronous
retention pass; read its run status before claiming deletion completed.
Credentials, identity verification, provider login, uploads and other operations
owned by an existing UI use an explicit interactive handoff. Such a link is not a
claim that Chatty executed the operation.

`api/src/services/chatty/surface-inventory.json` classifies every admin route as a
typed tool, interactive handoff or exclusion. Its CI check rejects new unclassified
routes and stale entries. Some tools deliberately narrow a route: schedule pause
can only set enabled=false; it cannot edit a prompt or reactivate work.

There is no generic HTTP, SQL, shell, agent-message or work-dispatch tool.
Chatty is an application administrator, not a system runner. It cannot start host
tasks or workflow runs, create/reactivate schedules, enable task recovery or
start daemon sessions. MCP descriptions in its knowledge are explanatory data,
not permission to invoke the full fleet MCP surface.

## Rich replies: links and suggestions

An answer can carry up to eight elements, rendered under the text: console
buttons (at most six) and follow-up suggestions (at most four). The model writes
only symbolic references such as `{"type":"link","kind":"host","ref":"example.com"}`
or `{"type":"suggestion","text":"Ist example.com online?"}`. It never writes a URL,
path or label; a field like `href` or `label` invalidates the element.

`api/src/services/chatty/elements.ts` resolves each reference server-side:

| Kind | Reference | Destination | Read capability |
| --- | --- | --- | --- |
| `host` | FQDN or numeric ID; internal hosts never resolve | `/hosts/<id>` | `hosts.read` |
| `project` | slug, optional `view` board/documents/reports/activity | `/projects/<slug>[/<view>]` | `projects.read` |
| `skill`, `subagent`, `command`, `output-style` | slug, not deleted | `/library/<type>/<slug>` | `content.read` |
| `workflow` / `workflow_run` | definition slug / run UUID | `/workflows/definitions/<slug>`, `/workflows/runs/<id>` | `workflows.read` |
| `account` | numeric ID, not being removed | `/accounts` (no detail route exists) | `auth.read_metadata` |
| `manual` | shipped manual article slug | `/manual/<slug>` | `admin.read` |
| `page` | a fixed page name such as `settings`, `chatty`, `limits`, `engine-state` | the registered console route | page-specific |

The resolver checks that the entity exists and that the acting admin's role holds
the capability, then builds the path from that template and the label from the
stored name (control and bidirectional characters removed, bounded length). A final
pattern accepts only known console route prefixes; no scheme, host, `..` or `//`
can survive. Text in tool output, host names or documents therefore cannot create a
destination outside this set. The `ui_links_check` tool runs the same resolver so
the model can confirm a reference before answering, for example to answer "Habe
ich einen Host example.com?" from real data.

If an answer contains a reference the server refuses, the run gets one correction
turn telling the model to answer without it, so the text does not promise a
missing button. Anything still refused afterwards is dropped and counted in
`elements_omitted`; the panel says so. Resolved elements are stored with the
encrypted answer event, appear on reload and in other tabs, and Clear deletes them.

The panel navigates with the SvelteKit router (`paths.base` added on the client;
modified clicks open a new tab). The desktop panel stays open; the full-screen
phone panel minimizes so the destination is visible, and reopening shows the same
conversation. Only the latest answer offers its suggestions; a suggestion is sent
as an ordinary user message and cannot approve an action. Mutations Chatty itself
performs still go through the confirmation card below; action buttons (next
section) are executed by the console through the ordinary admin endpoints.

## Action buttons

An answer can also offer up to three action buttons, for example "Habe ich einen
Host example.com?" → [Host example.com öffnen] plus [Claude auf example.com
aktivieren]. The model writes only `{"type":"action","action":"host.engine.enable",
"params":{"host":"example.com","engine":"claude"}}`; it never writes a URL, request
body, label or risk. It can check proposals first with the read-only
`ui_actions_check` tool.

`api/src/services/chatty/actions.ts` holds the closed registry:

| Action | Parameters | Risk | Existing endpoint the console calls | Capability |
| --- | --- | --- | --- | --- |
| `hosts.filter` | `status` online/offline/attention and/or `flag` vip/roaming/secure/insecure/unprovisioned | safe | navigation to `/hosts?status=…&flag=…` | `hosts.read` |
| `activity.host` | `host`, optional `window` 1h/24h/7d | safe | navigation to `/activity?host=<id>&window=…` | `audit.read` |
| `host.engine.enable` | `host`, `engine` | confirm | `POST /admin/hosts/:id/engines` (current list plus the engine) | `hosts.security_transition` |
| `host.engine.disable` | `host`, `engine` | danger | `POST /admin/hosts/:id/engines` (current list minus the engine) | `hosts.security_transition` |
| `host.auto_update` | `host`, `enabled` | confirm | `POST /admin/hosts/:id/auto-update` | `hosts.manage` |
| `host.insecure.close` | `host` | confirm | `POST /admin/hosts/:id/insecure/disable` | `hosts.activate_insecure` |
| `account.verify` | `account` | confirm | `POST /admin/accounts/:id/verify` | `auth.manage` |
| `versions.check` | none | confirm | `POST /admin/versions/check` | `settings.manage` |

For each proposal the server checks the parameters, that the entity exists (internal
hosts and accounts being removed never resolve), that the acting admin's role holds
the capability of the existing route (a unit test pins it to the route inventory),
the engine master switch where the action is engine-scoped, and that the operation
is not a no-op or bound to fail: an engine already assigned, the last engine of a
host, a host without an open insecure window or with the fleet window open, an
unchanged auto-update override. Adding an engine that is switched off fleet-wide is
refused; removing one is allowed, matching the host service. `account.verify`
requires the account's engine to be switched on. The label and the dialog text come
from templates in that file and the stored entity name (control and bidirectional
characters removed); model prose never becomes button text.

A resolved element carries an opaque proposal token: an HMAC with the active
encryption key over action, canonical parameters and expiry, bound to the admin
user, the admin session and the conversation generation. It is valid for 15
minutes. Another login, another user, Clear (new generation) or a changed key makes
it invalid. Tokens are stateless; within their lifetime a button can be used more
than once, exactly like the page button it mirrors.

The console has its own allowlist (`frontend/src/lib/components/chatty/actions.ts`):
it fixes each action's risk, so a tampered payload cannot downgrade a mutation to a
direct click, builds navigation paths only from enumerated filter values, and
accepts a server plan only when it fits the endpoint (for engines: the list after is
the list before plus or minus the named engine, never empty). Safe actions navigate
directly. Any other action opens the shared confirmation dialog, which first calls
`POST /admin/chatty/proposals/verify` and shows the fresh title, target, summary and
consequences. Danger actions additionally require typing the host name. On confirm
the console verifies again; if the plan changed, it shows the new description and
asks for a new confirmation. Then it calls the existing endpoint through the same
client mutation the page uses, so the route's own capability gate, validation and
whatever audit record it writes apply unchanged. The outcome appears under the buttons; a refused request says it
did not run, a transport or server failure says the outcome is unknown. Expired
buttons are disabled with a note to ask again.

Chatty's server never executes these operations, and they produce no Chatty action
receipt. The model learns about them only through fresh reads in a later request.

Deliberately excluded, even though admin endpoints exist: deleting anything (hosts,
accounts, projects, schedules, content), clearing host auth, minting installers
(the install command embeds the host credential) and host API key rotation, gateway
or provider key management, secrets, users and admin roles, the API kill switch and
engine master switches, opening insecure access (host or fleet window), marking
hosts secure/insecure, releasing IP bindings, workflow runs, schedules, agent
sessions and messaging. A host "sync now" action does not exist because hosts pull
their configuration and there is no admin endpoint that pushes a sync; enabling or
disabling an engine is picked up at the host's next synchronization. ChatGPT usage
refresh (`POST /admin/chatgpt/usage/refresh`) is Codex-only, with no Claude or Grok
counterpart, so it is not offered; `account.verify` covers all three engines.

Deviation from the original design note: the token is stateless rather than stored,
so no migration is needed. The short lifetime, the session and generation binding
and the re-verification before every execution take the place of single use.

## Execution and confirmations

Ordinary clear instructions may execute directly. Ambiguous requests produce a
persisted question. Destructive, security, account and fleet configuration changes
produce a concrete action card containing the tool, arguments and target snapshot.
Decisions expire after 30 minutes. The action transaction locks the conversation
and target, checks the current user/session/capability and generation, compares the
target snapshot, executes the domain service and commits an encrypted receipt.
A changed target fails the old action. Database changes and the successful receipt
commit together; a failed transaction rolls them back together.

The worker uses durable claims rather than process-local ownership. An expired
claim becomes unknown and is never automatically replayed. Completed receipts
remain authoritative. A new request requires checking the affected target when
an interrupted operation has no known outcome.

The isolated runner accepts only a protocol-1 turn and returns one JSON answer,
question or proposed tool call. The API validates it and allows one format repair.
Native CLI tools/MCP/web/subagents are disabled by engine-specific command flags.
The runner bounds output, uses a new temporary home and an allowlisted environment,
and kills the subprocess group on timeout, disconnect or cancellation. Product
tools run only inside the API, with the current admin identity.

Defaults: one active request per user; two concurrent requests installation-wide;
twenty queued requests; five-minute queue wait; twelve model steps and at most
twenty-four tool calls; 120 seconds per native turn and ten active minutes per
request. A confirmation wait does not consume active time. Runner capacity is
separate from auth verification. Saturation is an explicit busy response.

Personal SSE notifications trigger canonical conversation reads. No conversation
content enters the global admin WebSocket bus. Reconnect fetches current state,
including clear-generation changes. This streams real completed steps and receipts;
it does not simulate provider token streaming. Bounded recent context includes
deterministic excerpts of older messages; history paging remains available.

## Delivery and verification

Migration 0050 creates the four Chatty tables and is idempotent. API schema and
fresh-install baseline are updated together. API and runner must be rolled out
together to enable inference. An older runner leaves Chatty unavailable.

Canonical checks are API typecheck/lint/tests, the real-MySQL migration and Chatty
lifecycle suites, runner unittest discovery, frontend check/build and the Chatty
Playwright tests (desktop/mobile and axe). The retrieval fixture contains 40 DE/EN
questions and requires supporting evidence in the top five for at least 90%.
Mocked provider output and real subprocess tests prove orchestration, not the
quality or compatibility of a live subscription/model. Each installed engine still
needs a deployment smoke test with its own managed provider account.

To disable without deleting history, turn Chatty off in the engine settings.
Rolling back API/runner binaries does not require dropping its additive tables.
Never rotate or discard the encryption key to roll back this feature.
