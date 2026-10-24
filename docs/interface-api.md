# API Interface (Source of Truth)

## Current owner-mode contract

Routine HTTP request/completion logs are disabled; request errors remain logged.
The audit stream omits successful version-report and message-delivery copies
(`cron.update_reported`, `cron.update_available`, `agent_message.delivery`,
`agent_message.completed`). Canonical host/message records, authentication
changes, administrative actions and failed/ambiguous audit events remain.

Response authorization accepts ordinary extensions of an already admitted
insecure-host window. Shortening or closing the window, rotating credentials,
or changing host IP policy still invalidates pending responses.

The running API is the single owner of bounded current-state metadata in RAM.
It hydrates once under exclusive database ownership; production also holds the
shared-storage kernel lock before bootstrap. Durable commands commit state,
receipts and required effect intents before publishing revisions. Current-state reads
and transport liveness do not poll SQL; requested historical/encrypted bodies
remain explicit cold reads. See [control-plane-owner.md](control-plane-owner.md).

New connection-owned grants use authenticated session/binding/native-instance
proof. Disconnect, silence, owner restart and old timestamp expiry do not prove
execution ended or release uncertain work. Genuine authorization, retry, business
and retention deadlines still apply. Legacy timed rows and draining old processes
retain their explicitly bounded compatibility behavior; a retained expiry column
does not make a connection-owned row a timed lease.

Negotiated `control_state_v1` streams deliver authenticated snapshots and deltas;
communicator WebSocket and local Unix-socket liveness replace recurring domain
polling. Pings do not renew durable leases or insecure grants. Finite mutation
routes retain their identity/idempotency contracts and revalidate authority.
Host-0 reservations belong to internal API inference tasks: bootstrap removes
only their connection-owned grants after the shared-storage lock proves the old
API drained or exited. Remote reservations and legacy timed grants survive this
cleanup. This recovery releases reservations, never replays the interrupted task.

## Communicator cache protocol 2 (cxx 0.9.122)

Only actually retained, future-valid OAuth resources shorten the confirmation
budget. A verified native refresh package with expired access remains inline in
the fresh authorized response and is never reused from cache. Its access expiry
does not zero the live admission proof; engine refresh ownership is unchanged.

- `POST /sync/cache` — authenticated, server-confirmed resource read. Requires communicator transport and sync enabled. Body: `protocol:2`, UUID `request_id`, original `method`, allow-listed relative `path`, original JSON `body`, allow-listed `headers`, and `known:{<JSON resource path>:<sha256>}`. Host key and client IP are pinned by the outer request; MCP bearers must belong to that host. Arbitrary paths, forwarding headers, writes and MCP tools are refused.
- Supported sources: content bootstrap, agents/config retrieval, Skill list/retrieval, selected Skill MCP/resource reads, auth retrieve and account-session acquisition. Admission and credential exchange still execute each time; their results are not memoized. Bootstrap sends a candidate once, then reads content in a separate consistent transaction. Post-dispatch failures retain `409 communicator_outcome_unknown` semantics.
- Success: standard `{status:"ok",data:{protocol,request_id,checked_at,valid_for_ms,status,headers,body,resources}}`. Each resource has `path:string[]`, `revision`, `sha256`, nullable `valid_until`, and base64 JSON `content` only when not already known. `body` contains null placeholders at those paths. Status, authorization, quota and RPC IDs remain fresh. Full resource inventories preserve deletions. Each confirmation is usable only for this request, for at most 30 seconds including transport time and less when an OAuth access expiry requires it. Unknown expiry credentials and insecure-host content are not cached.
- In owner mode, fresh authorization checks use the authoritative RAM snapshot; explicitly requested cold content is read separately and authority is revalidated before delivery. The legacy path bypasses its periodic DB read cache and shares a repeatable-read snapshot. The owner verifies correlation, digests and deadlines before reconstructing a reply; no stale fallback exists for new protocol-2 launches. Existing native processes continue. Signed configs select protocol 2 for reported cxx >=0.9.122; older callers retain protocol 1. See [communicator.md](communicator.md).

- `POST /host/agent-sessions/{id}/agent-messaging/digest` — bridge-authenticated original retrieval for a negotiated smart-queue digest. Body: `digest_id`, optional `after` dispatch cursor and `limit` (1–20). Returns `messages` and `next_after`; grouping is never a read receipt. See [Smart queue](smart-queue.md).

## Smart queue delivery v1 (cxx 0.9.87)

Native receivers negotiate an opt-in catch-up digest and a coordination lane
while accepted work remains held. Send/reply accept explicit `delivery_class`,
`coalesce_key`, and `related_work_id`; `agent_digest_get` retrieves paginated
originals. Calls, conferences, task results and operator messages remain full.
Work IDs and auth/admission fences are preserved. The server flag defaults off;
see [Smart queue](smart-queue.md) for limits, canary setup and rollback.

## Automatic repository delivery

When Git Director is enabled, its managed instructions require agents to call
`git_list` before registration and `agent_list(scope:"checkout", online:true)`
before edits, without engine/name filters. Only complete coverage for the actual
checkout root with zero peers means free. Occupied or unknown checkouts use a
unique task branch and linked worktree outside the original checkout, based on
its recorded HEAD. The Director's one registration per path is not an agent count.
Registration uses the actual worktree; an occupied original registration is preserved.

Agents verify and commit task-owned changes even when alone. Shared-branch commits
and merge-back require a Director lease; direct commits report task-owned staged
paths, isolated commits report `base...head` paths. Integration requires a clean
original checkout still on its original branch. Conflicts are resolved and checked
in the task worktree. Dirty/changed targets, denial or unresolved conflicts leave
integration pending with the committed result retained. An ancestry check prevents
duplicate merges on retry and gates cleanup of only the task's own worktree/branch.
Detached HEAD always isolates and requires an operator-selected integration target.
Read-only tasks do not mutate Git. Explicit restrictions override these defaults;
push/deploy remain separately authorized. Agents execute this advisory workflow;
neither the server nor wrapper enforces filesystem operations. Existing active
sessions may retain older instructions; adopt with the next content sync/launch.

## Fleet commit preferences

- `GET /admin/git-director/commit-settings` requires an admin session and `git_director.read`; returns `{ message_style: "short" | "long", ai_attribution: boolean }` in the standard envelope. Missing or invalid stored values yield `short` / `false` without writing.
- `POST /admin/git-director/commit-settings` requires `git_director.manage` and both fields with exactly the types above; unknown fields or invalid values return 400. Stores the whole pair as JSON in `versions.git_commit_settings` (last accepted write wins), emits `settings.changed` and records/broadcasts `git_director.commit_settings_updated` with the operator's `admin_user_id`. No migration or engine-specific override.
- Managed host documents and admin previews carry a mandatory `git_commit_messages` section, with section digest and preview provenance `feature:git_commit_messages`. Short means subject only; long adds change/reason and relevant verification. Attribution adds one engine-specific `AI-Assisted-By: Codex|Claude|Grok` trailer after a blank line, including with short messages. Off forbids automatic AI markers/co-authors. Git identities and commit/push authority are unchanged; explicit operator instructions take precedence.
- Preferences are independent of Director, MCP and Skills activation. Hosts adopt the changed document hash on their next sync/launch; active sessions may retain previous instructions. The explicit blank AGENTS generation mode still suppresses managed guidance. Host document rendering degrades to the defaults if settings are temporarily unavailable.

## Native launch connection reuse (cxx 0.9.24)

Managed native command entrypoints and `cdx`/`clx`/`cgx` share the existing
host-authenticated `/host/agent-sessions` registration and scoped bridge receiver
lifecycle. No new launch endpoint, credential exposure or schema change is
introduced. Receiver registration still requires matching engine/protocol,
actual native identity, fresh generation and live policy; session heartbeats do
not replace native receiver evidence. Existing execution-contract-v2 acceptance,
result idempotency and fresh-start gates apply to both entrypoints.



## Grok engine contract

`engine="grok"` and `X-Engine: grok` select the third engine; `cgx` is its wrapper.
Absent hints retain the Codex compatibility default; unknown engines are rejected.
Any nonempty subset of the three engines is valid for a host. Grok model defaults,
config, runner state, auth digest, host pin, wrapper version, and instruction state
are engine-specific. Subscription credentials are modern xAI OIDC scope maps;
legacy web login and metered provider API keys are unsupported.

Ordinary `/auth` retrieve and account-session auth return an access-only Grok projection,
`canonical_generation`, `access_token_digest`, `expires_at`, and refresh state.
Reactive `refresh_if_generation` requires the exact active host/account/session;
only the centralized owner can spend a refresh token. Pending/ambiguous renewal
returns a typed error. Full native login uploads remain encrypted server-side;
runtime External projections cannot advance canonical auth. Account leases cannot
resurrect after expiry. See [complete Grok contract](interface-cgx.md).

Grok startup and doctor instead send `POST /auth` with
`{engine:"grok", command:"retrieve", metadata_only:true}`. This returns normal
host/version metadata, `account_pool:true`, `metadata_only:true`, stored
`verification_state`, nullable `canonical_generation`/`canonical_last_refresh`,
and `status:"available"|"missing"`. Stored credential metadata may also include
`access_token_digest` and `expires_at`; no credential bytes are returned.
`available` describes a stored payload, not a fresh provider validation.
`pool_verified_accounts` counts enabled accounts with a verified payload, the
candidates `/auth/sessions` would choose from; it reserves nothing. This path
does not call `ensureFresh`, contact xAI or acquire an account lease. Startup
selects and acquires its actual account grant through `/auth/sessions`; doctor
remains a metadata inspection. Normal host, engine and access checks still apply.

The independent OpenAI-shaped `/grok/v1` group serves `POST /grok/v1/chat/completions`,
`POST /grok/v1/responses`, `POST /grok/v1/completions`, `GET /grok/v1/models`, and `GET /grok/v1/models/:model`
under that prefix. `POST /grok/v1/embeddings` returns unsupported endpoint.
`/admin/grok/keys` CRUD issues engine-scoped `sk-cgx-` gateway client keys.
`/admin/grok/state`, `/admin/grok/settings`, and `/admin/grok/models` control the
independent gateway. Model/system/text controls are supported; sampling, caps,
stop sequences, tools, streaming, and images fail explicitly before execution.
Unknown native usage is `null`; native stop reason is mapped when available.

Grok's native receiver protocol is `grok-acp-v1`; receiver readiness and delivery
are based on native session/queue evidence. Messaging supports all nine engine
source/target pairs. Grok quota has no synthetic percentage or capacity claim.

## Exposed API routing (any-to-any)

Generation requests accept an omitted, null or boolean `stream` flag. Other
values return `400 invalid_stream` before execution; Grok continues to refuse
`stream: true`. Synthesized streams preserve the backend's reported finish
reason, including `null` when unknown, instead of inventing a clean stop.
Client disconnect and API pre-close abort in-flight execution for every backend
and surface; adapter timeouts include reading the response body. An aborted
call cannot record a successful auth verification.

The three inference gateways are **surfaces**; the engine that answers is the
surface's **backend**, chosen per surface and resolved per request (1 s cache),
so a change applies without a restart.

| Surface | Base path | Wire | Keys (`openai_api_keys.engine`) | Kill switch | Backend row (default) |
|---|---|---|---|---|---|
| `openai` | `/v1` | OpenAI | `sk-cdx-` (`codex`) | `openai_api_disabled` | `api_surface_backend_openai` (`codex`) |
| `anthropic` | `/anthropic/v1` | Anthropic | `sk-ant-` (`claude`) | `claude_api_disabled` | `api_surface_backend_anthropic` (`claude`) |
| `grok` | `/grok/v1` | OpenAI | `sk-cgx-` (`grok`) | `grok_api_disabled` | `api_surface_backend_grok` (`grok`) |

- URL, wire shape, error envelope, key namespace and kill switch belong to the
  surface and never change with the backend; `openai_api_keys.engine` names the
  surface's key namespace, not the engine that answers. A missing or invalid
  backend row means the identity backend (migration `0038` seeds it explicitly).
- Each key may independently pin `backend_engine` to `codex`, `claude`, or
  `grok`. NULL keeps endpoint-default routing. Resolve the effective backend
  once per authenticated request and use it for availability, models and execution;
  a disabled endpoint default does not block keys assigned to an enabled engine.
- Key creation on `/admin/openai/keys`, `/admin/claude/keys` and
  `/admin/grok/keys` accepts optional `backend_engine`
  alongside `name` and `expires_at`. Omission preserves legacy default routing;
  explicit invalid values (including NULL) return 400, and fleet-disabled engines
  return `409 engine_disabled`. Creation and list records include nullable
  `backend_engine`; the legacy `engine` field remains the key namespace.
  Assignments cannot be edited; issue a replacement key to change the engine.
- The backend supplies the canonical credential snapshot, the runner `engine`,
  the capability table and the model catalog. Each engine's backend exists once
  per API process, so Grok's single central refresher is shared by every surface
  routed to Grok.
- Controls follow the backend: a control it cannot honour fails with
  `400 unsupported_generation_control` before credentials are read. On the
  Anthropic wire, Codex receives `system` as a leading `system:` transcript line
  and Grok does not receive the protocol-mandatory `max_tokens` (accepted,
  unenforced); Grok refuses `stream`, images and sampling controls on every
  surface. Usage and stop reasons are translated into the surface's vocabulary
  (Codex reports no tokens: zeros, or `null` where the OpenAI wire already used it).
- Models: `/models` lists the backend's catalog in the surface's shape. A
  generation request whose `model` is empty, or belongs to the surface's native
  family (`gpt-*`/`o*`/`codex-*` on `/v1`, `claude-*` on `/anthropic/v1`,
  `grok-*` on `/grok/v1`) but is not served by a foreign backend, runs on the
  backend's default model and reports it in the response `model` field. Other
  unknown ids, admin-disabled models and single-model lookups stay strict.
- `GET /admin/api/surfaces` (`settings.read`) →
  `{surfaces:[{surface,label,base_path,wire,backend,identity_backend,disabled,key_count}],
  backends:[{engine,label}]}`; `key_count` counts active keys.
- `POST /admin/api/surfaces/{surface}` (`settings.manage`) with
  `{backend?: "codex"|"claude"|"grok", disabled?: boolean}` (at least one) returns
  the updated row. Backend changes are audited as `admin.api.surface_backend`
  `{surface, backend, previous}`; `disabled` writes the surface's kill-switch flag
  under its legacy audit action. Unknown surfaces or engines return `422`.
  Routing a surface onto a backend that is switched off fleet-wide returns
  `409 engine_disabled` (`scope:"fleet"`); leaving it where it is stays allowed.

The API Access UI defaults to endpoints and key management. `#configuration` opens routing, collapsible backend defaults and the global API control. Existing anchors (`#service-availability`, `#exposed-apis`, `#claude-proxy`, `#grok-proxy`, including inner engine anchors) still open their matching controls. `?dialog=new&engine=openai|claude|grok` opens key creation and selects that API's key tab; key namespaces are independent of the selected backend. The creation dialog requires an explicit engine choice independently of API format. Its responsive connection summary shows the assigned engine, expiry, availability, copyable key, SDK base URL, models and generation URLs, plus a curl example with a model placeholder. The key list distinguishes assigned engines from Endpoint default. Configuration changes the default only for unassigned keys; endpoint switches apply to all keys.

## Engine master switches

Messaging and portal engine-state checks inside a transaction use that transaction connection; they never acquire a second pooled connection while holding messaging locks. The admin startup gate redirects to setup only after a successful auth-status response confirms the installation is unclaimed; an unreachable API preserves the current route. Authenticated installations with an owner and at least one existing host skip automatic wizard offers even when no wizard completion record exists; a bare `/admin/setup` URL also returns existing fleets to the dashboard; explicit `?step=…` setup links remain available.


One fleet-wide on/off per engine (`api/src/services/engine-switch.ts`). Off
means **suspended**, never removed: host engine assignments, accounts, canonical
auth, keys and installed CLIs are all kept, and switching it back on restores
everything without a reinstall.

- Storage: `versions` rows `codex_engine_disabled`, `claude_engine_disabled`,
  `grok_engine_disabled` (truthy = off). A missing row means on, so existing
  installs are unchanged. Reads are cached for one second per process and
  invalidated by every write; a failed read serves the last value seen, else "on".
- `GET /admin/engines/state` (`settings.read`) →
  `{engines:[{engine,label,enabled,updated_at,updated_by,assigned_hosts}]}`,
  always three rows in canonical order; `assigned_hosts` counts active hosts
  carrying the engine.
- `POST /admin/engines/{engine}/state` (`settings.manage`) with `{enabled: boolean}`
  returns the updated row plus `previous` and `hosts_suspended`. One transaction
  writes the flag, bumps every host's `config_version` (so each signed wrapper
  config is re-baked), suspends Agent Messaging for that engine on every host
  carrying it (the host-level engine-removal path), and writes the audit row
  `admin.engine.state` `{engine, enabled, previous, actor, hosts_suspended}`.
  Then it publishes `engine.state.changed {engine, enabled}` and
  `settings.changed`. Repeating the current state is a no-op. All three may be
  off at once; the admin API never depends on an engine.
- Host routes refuse a switched-off engine with `403 engine_disabled` and
  `scope:"fleet", engine` (`POST /auth`, `/auth/sessions`, `/sync/status`,
  `/sync/bootstrap`, `/claude/usage/report`, `/cron/check`, `/cron/report`,
  `/host/lane`, `/mcp`, `/skills`, `/agents/retrieve`, `/config/retrieve`,
  `/claude/{kind}`, agent-portal and Agent Messaging registration and bridges).
  Host-level removal keeps the same code with `scope:"host"`, and wins when both
  apply. `/auth/sessions/heartbeat` and `/auth/sessions/release` check only the
  host assignment, so a running session keeps the lease it holds; the server
  stops refreshing on its behalf (a Grok heartbeat returns
  `refresh_state:"suspended"` without calling the refresher).
- `GET /wrapper/v2/config` (and every `/wrapper/v2/*` download) checks only the
  host assignment. A suspended engine still gets a **200** signed config whose
  `host.fleet_disabled_engines` lists the switched-off engines and whose
  `agent_messaging` / `remote` blocks are off. It is deliberately not a 403:
  wrappers delete an engine's alias and config on 403 `engine_disabled`, and a
  host whose every engine was suspended could then never recover.
  `host.engines` / `host.engines_list` stay the assignment in both the signed
  config and `/auth` (`host.fleet_disabled_engines` is separate), so drift
  detection never mistakes a suspension for a removal. `/versions` and the
  `/auth` `versions` block carry `fleet_disabled_engines` too.
- Gateways: a request whose **effective backend** (key assignment, else endpoint default) is switched off returns `503 api_disabled`
  (`reason:"backend_engine_disabled"`, `engine`) in the surface's own wire
  envelope. Keys using another enabled engine keep serving, including when the endpoint default is disabled. The endpoint kill switch still blocks every key on that endpoint.
- Admin actions that would reach a provider, the runner or a host for a
  switched-off engine return `409 engine_disabled` (`scope:"fleet"`): canonical
  auth stores (admin upload, seed, bootstrap — the `storeCandidate` chokepoint),
  `/admin/auth/seed-command`, `/admin/runner/run{,-claude,-grok}`,
  `/admin/chatgpt/usage/refresh`, AI-assist drafts (Codex), minting an installer
  for it, and newly assigning it to a host (`/admin/hosts/register`,
  `quick-register`, engines edit, installer "add engine", `/cli/auth/approve`).
  An engine a host already carries may stay assigned. Omitted engines on
  register fall back to `DEFAULT_HOST_ENGINES` minus switched-off ones.
  `/install/{token}` and `GET /seed/auth/{token}` answer with an
  `engine_disabled` installer error without consuming the token.
- Background work skips the engine: the auth-verification worker neither
  verifies nor refreshes it, the Grok refresher refuses, and the
  `chatgpt-usage-worker` container reads the Codex flag every tick, polls nothing
  while it is off and keeps its health heartbeat fresh (`suspended`).
- Config editing (model defaults, AGENTS/config documents, authoring, host
  previews) stays available while an engine is off.
- `/admin/overview` carries `fleet_disabled_engines`; setup status drops
  switched-off engines from `default_engines` and from its `auth_<engine>`
  next actions.


### Engine destroy

Suspending an engine keeps everything; *destroy* removes it from every host.

- `POST /admin/engines/{engine}/destroy` (`settings.manage`) `{confirm: "<engine>"}` requires the engine to be suspended. One transaction writes the `versions` row `<engine>_engine_destroy` (`{request_id, requested_at, requested_by}`), inserts one `engine_destroy_hosts` row (`pending`) per host carrying the engine, bumps every host's `config_version` and audits `admin.engine.destroy`. Idempotent: an open request is returned with `already_open`.
- The signed wrapper config carries `host.destroy_engines: [{engine, request_id}]` for hosts that have a progress row. Wrappers older than this feature ignore the field and only suspend.
- The cxx cron coordinator (`internal/cron/destroy.go`) runs `internal/enginedestroy` once per request id: native shim, alias, signed config, `~/.cxx/engines/<engine>`, npm-global install, the engine's home (`~/.grok` + `~/.cgx`; `~/.claude` + `~/.clx` + managed `mcpServers` in `~/.claude.json`; `$CODEX_HOME`/`~/.codex`), temp runtime dirs and shell alias lines. User-authored `mcpServers` and other engines are untouched. It reports `running`, then `done` or `failed` with the residue to `POST /host/engine-destroy/report`, and writes `~/.cxx/state/engine-destroy-<engine>.json` only after a fully clean run, so failures retry on the next tick. The destroyed engine's config is never re-persisted afterwards.
- `GET …/destroy` returns progress; `DELETE …/destroy` cancels (hosts that already finished stay destroyed); `POST …/destroy/purge {force?}` deletes the engine's auth payloads/entries, canonical head, provider accounts and sessions, seed/install tokens, host auth state and unassigns the engine from hosts that have another engine.
- `POST /admin/engines/{engine}/state {enabled:true}` is refused (`409 engine_destroy_open`) while a request is open.
- Destroy is irreversible for native credentials and history on the hosts.

## Host-facing

- `X-Request-Id` accepts `[A-Za-z0-9._-]{1,128}`; absent or malformed values
  receive a generated ID before request logging starts. Incoming/completed
  log entries, `req.id`, and the response header share the same ID.
- Base URL for baked wrappers/installers honors `PUBLIC_BASE_URL` when set; otherwise it is derived from trusted `X-Forwarded-Host`/`Host` + trusted `X-Forwarded-Proto` (`TRUST_X_FORWARDED=1` and the socket peer address in `TRUSTED_PROXY_CIDRS`, validated against `https?://`). If no valid base can be resolved, installer creation fails and host `/auth` responses omit per-host wrapper baking metadata.
- Base URL policy guard: when `PUBLIC_BASE_URL_REQUIRED=1` (default in production), requests fail fast if `PUBLIC_BASE_URL` is missing/invalid. Optional host validation (`STRICT_HOST_VALIDATION=1`) rejects requests whose effective host/port do not match `PUBLIC_BASE_URL`.
- MCP origin policy: `/mcp` has no origin allowlist — while `MCP_ALLOW_REQUEST_HOST_ORIGIN` is off (the default) any request that sends an `Origin` header is rejected with 403, and enabling it accepts every origin.
- Contract schemas for critical host responses live under `docs/contracts/` and are CI-gated: `auth-retrieve.schema.json`, `auth-store.schema.json`, `versions.schema.json`, `sync-status.schema.json`, and `sync-bootstrap.schema.json`.
- Pruning: hosts inactive for `inactivity_window_days` (default 30; set to `0` to disable; configurable in `/admin/policies`) are deleted by the periodic retention worker (300 seconds by default) and during register/admin host listings. Never-provisioned hosts older than 30 minutes are also pruned. Hosts with `expires_at` in the past are pruned as well (temporary/rescue hosts; expiry is refreshed on successful host contact).
- `POST /auth` — retrieve/store canonical `auth.json` for the calling host. Requires API key (`X-API-Key` or `Authorization: Bearer`). Engine resolution is multi-source: request body `engine`, query `?engine=...`, `X-Engine`, then wrapper user-agent fallback (`clx` => `claude`, `cgx` => `grok`), defaulting to `codex`; if that engine is not enabled in the host's `engines` set the server returns `403 engine_disabled`. `command` defaults to `retrieve`; `last_refresh` and `digest` are optional on `retrieve` (fresh-install/missing probes omit them), and when supplied they must be RFC3339 within the accepted bounds (≥ 2000-01-01, ≤ now+300s) and 64-hex respectively. `store` needs an `auth` payload with RFC3339 `last_refresh` plus `auths`; when `auths` is missing, Codex synthesizes it from `tokens.access_token` / `OPENAI_API_KEY`, while Claude synthesizes `auths["api.anthropic.com"]` from `api_key`, `anthropic_api_key`, `ANTHROPIC_API_KEY`, or `claudeAiOauth.accessToken`. The payload may include `session_started_at` (RFC3339) for compatibility with long-running clients. Tokens are canonicalized and quality-checked (no whitespace, min length `TOKEN_MIN_LENGTH` default 24 with an 8-char floor, rejects placeholders/low-entropy). Store requests are serialized per engine, runner-validated, and compare-and-swapped against canonical again before persistence; only recognized provider authentication rejection is definitive, while runner/provider/CLI infrastructure failures reject the upload without poisoning canonical auth. Retrieve/startup responses do not run live runner probes; they report the latest stored verification verdict maintained by the background auth-verification worker. Claude runner validation uses native Claude CLI validation for `claudeAiOauth` / `sk-ant-oat...` account-login payloads, and uses the direct Anthropic messages API only for genuine API-key credentials; Anthropic `rate_limit_error` probes count as valid credentials with temporary quota pressure. The same runner-validation/update path also applies to admin `/admin/auth/upload` and `/seed/auth/{uuid}` uploads, so runner `updated_auth` can become canonical from any upload path. Canonical payloads may be system-owned (`source_host_id = null`) and still count as valid canonical auth. Canonical auth, recent digests, and last-served host state are all engine-scoped; no two engines share one canonical payload pointer. When the client digest differs but `last_refresh` matches canonical, `retrieve` returns `upload_required` and a runner‑validated `store` may update canonical. Optional `installation_id` must match the server’s `INSTALLATION_ID` when provided; mismatches return `403 installation_mismatch` while omitted values are treated as legacy clients. Responses include status (`valid`/`upload_required`/`outdated`/`missing` for `retrieve`; `updated`/`valid`/`outdated` for `store`), optional `action:"store"` on retrieve when an upload is required, `versions` (client/wrapper plus `client_version_fetched_at`, `client_version_enforce_exact`, `wrapper_sha256`, `wrapper_url`, `auto_update_enabled`, runner telemetry, and `installation_id`), `api_calls`, `quota_hard_fail`, `quota_limit_percent`, `quota_week_partition` (0/off, 5, or 7), `cdx_silent`, and optional `host` metadata (fqdn/status/last_refresh/claude_last_refresh/updated_at/expires_at, client_version/client_version_override/claude_client_version/claude_client_version_override/agents_document_id_override/wrapper_version/claude_wrapper_version, secure/vip/allow_roaming_ips, `engines` plus parsed `engines_list`, insecure window timestamps + `insecure_window_minutes`, `browseros_mcp_enabled`, optional `lane_preference` (`normal` or `null`; a stored legacy `spark` is served as `null` since the Spark lane was retired on 2026-09-29) for wrapper lane steering, optional `model_override` / `reasoning_effort_override` for Codex, `claude_model_override` / `claude_reasoning_effort_override` for Claude, and the `grok_*` host fields listed in [interface-cgx.md](interface-cgx.md) for Grok). The Codex fleet target has an internal minimum floor of `0.125.0`; lower fleet pins, lower host overrides, and stale GitHub/cache results are all raised to that floor. Every engine resolves the served target the same way: the fleet pin from the `versions` table (an aliased `latest`/`auto` pin resolves to the cached upstream release), then any fleet-wide exact lock, then the calling host's own `client_version_override` / `claude_client_version_override` / `grok_client_version_override` column, which wins over both and forces `client_version_enforce_exact=true`. `client_version_enforce_exact=true` means wrappers must match the target exactly (upgrade or downgrade). `client_version_enforce_exact=false` means the target is floor-only and wrappers only upgrade toward it. `auto_update_enabled=true` enables background binary updates in cxx 0.8.2: one shared 15-minute maintenance schedule plus detached launch-triggered catch-up. Foreground sync does not run installers or reconcile schedules. Disabling binary auto-update preserves scheduled content/auth sync and later policy rechecks. Distributable canonical auth is returned only when the server copy is older-client-authoritative; a selected `verification_state=failed` lineage is reported as `outdated` without an `auth` blob. Codex responses always include a `chatgpt` object. With a readable snapshot it carries status/plan and provider flags (`rate_allowed`, `rate_limit_reached`, `spark_rate_allowed`, `spark_rate_limit_reached`) and exposes both quota lanes: `normal_window` and optional `spark_window` (each has `primary_window` + `secondary_window` with `used_percent`, `limit_seconds`, and reset timings), plus lane metadata (`spark_limit_name`, `spark_metered_feature`). With no snapshot, or when its read fails, the object is `{status:"unavailable", active_quota_lane:<host-effective lane>}` rather than `null`/omitted. Its `active_quota_lane` is host-effective response state, not account-snapshot state: a host with `lane_preference:"spark"` receives `spark`; every other host receives `normal`. Legacy clients keep working via the compatibility keys `primary_window` and `secondary_window` (mapped to the normal lane). Date-style shell wrappers (`wrapper_version` like `2026.01.13-03`) additionally receive the same object as `chatgpt_usage` on retrieve and store: the 2025.11–2026.03.05 scripts dereference that key unguarded and otherwise abort their auth pull with a Python `AttributeError`. `next_eligible_at` and daily partition metadata remain unchanged; the server refreshes snapshots opportunistically with a 5-minute cooldown. When reverse DNS enforcement is enabled (globally or per-host), `/auth` requests are rejected unless the caller IP appears in the host's A/AAAA records **and** the PTR record resolves back to the host FQDN. Denials expose stable reason details used by wrappers and tooling: `reverse_dns_mismatch`, `insecure_api_disabled`, and `installation_mismatch`. Insecure hosts default to API deny for retrieve-style access: registering an insecure host opens a provisioning window (defaults to 30 minutes, or `duration_minutes` from `/admin/hosts/register` when provided); dashboard "Enable" exposes a log-ish 0–480 minute (0–8 hour) slider (default 10) that opens a sliding `/auth` window, and each non-store `/auth` call extends the window by the configured duration. Submitted `/auth` `store` payloads are always treated as candidates regardless of insecure window/approval state, but still require normal auth/IP/reverse-DNS/installation checks and runner validation before persistence. "Disable" closes the window immediately. When insecure approvals are enabled and an admin websocket client is connected, closed-window `retrieve` requests return HTTP 423 `Insecure host approval pending` and `cdx` polls until approved or denied; pending approval requests auto-deny after five minutes and then return `403 insecure_denied` to the polling host; a request the host stops polling for 30 seconds is retired as `expired` (no cooldown) and replaced by a fresh one on the next poll. Active insecure-domain allows auto-open windows for matching subdomains during their allowed window, and those domain allow entries auto-revoke once the window expires. When `host.secure` is `false`, the last exiting auth-aware cdx/clx process purges native credentials while preserving explicit logout intent.
- Claude `/auth` retrieve/store responses include `claude_usage` from the
  latest stored Claude usage report; `/sync/bootstrap` and `/sync/status`
  include the same field inside their optional `auth` response. An available
  snapshot has `status:"ok"`, its original `fetched_at`, source/host metadata,
  and `five_hour_window` / `seven_day_window`, each containing nullable
  `used_percent` and `resets_at`; flat percentage/reset compatibility fields
  are also retained. No report returns `{status:"unavailable"}`. Availability
  is distinct from freshness: reading auth does not refresh the timestamp or
  contact Anthropic. A real `0` is preserved and a missing value remains null.
  Codex responses continue to carry `chatgpt` and never carry `claude_usage`.
- Grok `/auth` retrieve and store, and the optional `auth` object on
  `/sync/bootstrap` and `/sync/status`, include `grok_usage` only when
  `engine` is `grok`. It is the stored billing-period reading the dashboard
  already shows. `status` is `ok` or `unavailable`. An `ok` reading also has
  `used_percent` (a number, not an integer), `period` (`weekly`, `monthly`,
  or null), `resets_at`, `fetched_at`, and `stale`. Codex and Claude
  responses never carry `grok_usage`. The field is display-only: it does not
  enable quota hard-fail, account balancing, or another provider call. A
  missing account or an unreadable snapshot is `{status:"unavailable"}`.
- `/auth` native credential normalization: Codex selection matches native
  `AuthDotJson`: explicit `auth_mode` wins; otherwise a present top-level
  `OPENAI_API_KEY` wins over `tokens.access_token`. Accepted input is persisted
  as one native `chatgpt` or `apikey` shape with the shadow credential removed;
  unsupported modes fail closed, while legacy nested/auths keys are normalized
  before live verification. Claude selects native `claudeAiOauth` before API-key
  aliases and rejects `sk-ant-oat...` outside a non-empty native OAuth object.
  Codex and Claude strip the unselected native shadow and every non-native `auths`
  target before live verification and persistence. Pending, failed,
  non-canonical legacy, partial/stale-fingerprint, and fingerprint-mismatched
  rows never include auth bytes in retrieve/bootstrap. The worker immediately
  probes and reissues a nominally verified unsafe row, even when only its
  fingerprint metadata—not its canonical body—needs replacement. When a store
  probe changes the native credential before returning non-OK, persistence
  quarantines that replacement and atomically marks the same-lineage head
  failed only if that exact row is still selected. Unrelated credentials and a
  different concurrent compare-and-swap winner remain distributable.
- Gateway traffic verification credits the exact canonical snapshot executed
  by that request. Concurrent completions cannot verify a replacement, revive
  a failed/superseded generation, or rate-limit evidence for a newer head.
  Runner native files contain no spendable refresh material; Claude debug
  captures use the same stripped projection. See [session credential
  resilience](auth-resilience.md) for wrapper propagation and agent notices.
- `/auth` engine/timestamp compatibility: invalid explicit body/query/header
  engine hints return validation errors instead of falling back to Codex.
  RFC3339 values are calendar-validated, retain up to nine fractional digits,
  and are ordered without JavaScript millisecond collapse. Legacy Claude
  payloads may synthesize `auths` from `tokens.anthropic_api_key` or
  `tokens.ANTHROPIC_API_KEY` in addition to the top-level/native forms above.
- `/auth` canonical-ordering clarification — stores are serialized per engine
  inside the API process and compare-and-swapped again after the runner call.
  `last_refresh` values are normalized and compared as RFC3339 instants at
  nanosecond precision, not as text or JavaScript milliseconds. An upload from
  any host, admin, seed, or bootstrap path advances canonical only after a
  configured live runner returns a positive verdict; runner absence,
  transport/timeouts, provider 5xx responses, quota/model errors, and
  unrecognized CLI failures reject the upload without moving the canonical
  head. A changed runner readback must remain structurally runnable for the
  selected engine, retain the submitted credential kind, and retain any
  existing OAuth refresh token. Non-definitive or failed replacements may be
  retained as quarantined `pending`/`failed` history for diagnosis or retry,
  but are never selected by `auth_canonical_heads`, recorded as served, or
  included as `auth` in a host response. A previously verified explicit head
  that later fails verification is withheld; resolution does not fall back to
  an older credential behind it. An older candidate may repair that head only
  after live runner verification and receives the minimum generation strictly
  after the row it repaired. An accepted digest change on an exact timestamp
  tie is likewise restamped at least 1 ms after the selected lineage; runner
  `updated_auth` follows the same rule when its native file omitted or retained
  `last_refresh`. The advanced stamp must remain within the normal `now+300s`
  bound or the store fails closed. Equal/same-digest stores are idempotent.
- `/auth` credential-generation arbitration — canonical selection uses the
  engine's explicit `auth_canonical_heads` pointer, not a client timestamp.
  OAuth access/refresh pairs are compared through keyed HMAC fingerprints;
  plaintext tokens are never logged or stored in the ledger metadata. An exact
  match to a superseded generation returns `status:outdated` with
  `candidate_result:historical_replay` and never reaches the runner. Host OAuth
  candidates with comparable native `iat`/expiry metadata must be strictly
  newer than the current canonical generation; runner descendants, admin
  uploads, seed uploads, and opaque API-key candidates retain their existing
  validation/source policy. Responses expose `canonical_generation`; store
  responses may additionally expose `candidate_result` and
  `candidate_rejected_definitive` for guarded wrapper convergence.
- `DELETE /auth` — uninstall auth registration. `?engine=codex|claude|grok` removes
  only that engine, its host digest/state, and engine-specific version metadata
  when another engine remains and returns `{deleted_engine,remaining_engines}`;
  uninstalling the last engine removes the host. Wrappers delete shared
  `cxx`/aliases/cron only from an authoritative last-engine response; partial
  responses retain the remaining alias and shared artifacts, while offline,
  non-2xx, or malformed responses preserve all shared artifacts.
  Legacy requests without `engine` retain whole-host deregistration. IP binding
  is enforced unless `?force=1`; both paths are transactional and audit logged.
- `POST /sync/status` — batched startup diff probe for AGENTS.md and baked `config.toml`. Requires host API key + IP binding. Body accepts local digests (`agents.sha256`, `config.sha256`) plus optional host-user context. The `agents` block includes canonical `base_sha256`, combined `managed_sha256`, separate policy/features digests, and stable `sections` diagnostics for the mandatory fleet/safety/hard-stop prefix (`fleet_identity`, `safety_floor`, `hard_stops`, plus `standing_authorizations` and `response_style` when the posture or verbosity level renders them) and the feature blocks `skills`, `memories`/`memory_routing`, `projects`, `browseros`, `secrets`, `api_keys_in_chat`, `agent_messaging`, `git_director`, and `file_transfer`. Metadata describes guidance, never inventories. Optional `include_auth` retains the existing auth semantics. Contract: `docs/contracts/sync-status.schema.json`.
- `POST /sync/bootstrap` — batched startup payload endpoint. Uses the same input shape as `/sync/status`; when updates exist it returns changed payloads in one response (`agents.content`, `config.content`) plus `host_users`. Every successful response also includes the historical compatibility key `sessions:{now,today,month}` for the shared cdx/clx/cgx `ACTIVITY` section; older servers may omit it. The authoritative owner returns numeric zero placeholders for these retired counters: migration 0092 removed `agents.retrieve` telemetry, so they no longer measure activity, sessions or launches. Older servers derived `now` from distinct retrieving hosts over 30 minutes and `today` / `month` from UTC-boundary retrieval totals. Current connection activity is available through connection-owned presence. Wrappers pair them with their local same-UID wrapper process count and label the rows `local procs`, `hosts 30m`, `syncs UTC day`, and `syncs UTC month`. The `agents` block carries the same `base_sha256` / `managed_sha256` / `sections` metadata as `/sync/status`, so hosts and operators can inspect which feature hints affect the served engine/host document before or after a content fetch. Codex Skills are not bundled as local files; cdx reads manifests/support files through MCP `resource_read` at `skill://{slug}` / `skill://{slug}/{path}`. With usable orchestrator MCP (`agents.memory_routing.enabled=true`), Claude uses the same MCP Skill content path and receives an explicit empty `claude_skills` list to prune only previously fleet-owned native Skill directories. Omission is not a deletion instruction. This uses the managed configuration gate, not a live connectivity probe; transient MCP outages do not switch transport. Without usable MCP, Claude receives `claude_skills`, the complete live set of native fallback directory bundles; each changed source-owned item includes its rendered `SKILL.md` plus every `skill_files` entry, and the bundle digest changes when either the manifest or a support file changes. Reading Skill content through MCP does not register native Claude Skills or activate their native slash-command, hook, or filesystem semantics. Grok hosts receive `grok_skills` in the same shape and install it under `~/.grok/skills/<slug>/`. Both native bundles honor an optional request `skills` map of `{slug: sha256}` digests: content and files are omitted for a slug whose reported digest matches. Optional `include_auth` (default true) adds the same auth block as `/sync/status`; optional `auth_candidate` lets the endpoint auto-run the runner-validated `/auth` store path before returning canonical auth. Native Claude candidates without `last_refresh` are canonicalized for comparison first: if they match canonical they return `valid`; if they differ and are usable they are stored with a server timestamp instead of being overwritten by canonical auth. Successful inline stores add the `auth_stored` reason. When `include_auth=false`, no `/auth` retrieve/store path runs. Optional `include_content:false` (communicator warm-cache launch) skips every content renderer: no MCP bearer is minted. The response omits `agents`, `config`, `memory_routing`, `claude_*`, `grok_skills` and `sessions`, and carries `content: "omitted"`. Contract: `docs/contracts/sync-bootstrap.schema.json`.
- Bootstrap version snapshots and wrapper/platform projections are reused only
  within that request. Credential-store attempts and Grok refreshes invalidate
  them; failed reads are discarded so fallback reads retain their retry behavior.
  Each later request refreshes independently.
- Bootstrap candidate arbitration is fail-safe: deterministic malformed,
  unusable, or provider-rejected candidates set
  `auth.candidate_credential_rejected:true`, which tells the wrapper that the
  exact submitted generation cannot launch even when no canonical replacement
  exists. When an older verified canonical is also available,
  `auth.candidate_rejected_definitive:true` is emitted only with
  `status:outdated`, `verification_state:verified`, and an `auth` object; that
  stronger tuple is the only authority for replacing a locally newer candidate.
  When the selected head is failed and a usable candidate falls back after an
  infrastructure error, `auth.candidate_matches_failed_canonical` reports the
  server-side credential-identity comparison. `false` proves the local
  candidate is distinct and may be used while upload retries; `true` or an
  omitted/uninspectable comparison never bypasses the failed-head gate.
  Transient runner/provider/CLI/HTTP failures omit it and preserve the newer
  client generation for retry. Pending/failed history is quarantined and never
  returned; a failed explicit head is withheld rather than bypassed by an older
  historical row.
- `upload_required` is deliberately not a successful sync acknowledgement. The
  server records the presented digest/timestamp in the host's engine-specific
  drift fields for operators, but does not write `host_auth_states` or claim
  that canonical auth was served until the candidate passes the store gate.
- The embedded `/auth` and bootstrap-auth `versions` block is the engine-scoped
  `VersionSnapshot`: client target/override/exactness, wrapper version/hash/URL,
  engine-specific runner state, API and effective host auto-update flags, `cdx_silent`/`clx_silent`,
  installation ID, and engine. Quota controls and ChatGPT telemetry are sibling
  auth fields, not nested version fields.
- `POST /host/users` — record the calling host’s current `username`/`hostname` and return all known users for that host. Requires host API key (`X-API-Key` or `Authorization: Bearer`) and IP binding. Response: `{ users: [{ username, hostname, first_seen, last_seen }, ...] }`. Rows are deleted automatically when the host is removed.
- `GET /host/lane` — returns Codex-only lane steering metadata for the calling host. Explicit Claude hints return `422`; a host without Codex enabled returns `403 engine_disabled`. Requires host API key + IP binding and applies insecure-window checks. Response includes `lane_preference` (`normal`/`spark`/`null`) and `effective_lane`.
- `POST /host/lane` — Codex-only; rejects Claude hints and Codex-disabled hosts before changing lane or insecure-window state. Set/clear host lane preference with body `{ lane: "normal" | null }` (use `null` to clear; the retired `"spark"` sent by wrapper <= 0.9.5 is accepted and stored as `null`). Requires host API key + IP binding and applies insecure-window checks. Changes affect wrapper lane steering on the next `cdx` run.
- OpenAI-compatible API:
  - Native execution failures return `502 runner_failed`; the runner retains the last 500 characters of its diagnostic so a CLI banner cannot hide the provider error. The bundled Codex 0.162.1 runner must be rebuilt/recreated when upgrading from 0.154.0 to serve `gpt-6.1-sol` with ChatGPT credentials; successful key validation and model listing alone do not verify generation.
  - Gateway execution uses `AUTH_RUNNER_EXEC_TIMEOUT` (default 600 seconds), independently of the 8-second `AUTH_RUNNER_TIMEOUT` credential-probe budget. The runner enforces a 600-second maximum.
  - `POST /v1/chat/completions` — OpenAI-compatible chat completions. `messages[].content` may be a plain string or an OpenAI-style content-part array. Text parts plus `image_url` / `input_image` parts are normalized and forwarded to the runner, which materializes image URLs or base64 `data:` URLs into real `codex exec --image` attachments. Non-streaming returns a standard `chat.completion` object. Streaming now emits SDK-compatible `chat.completion.chunk` SSE payloads with `choices[].delta.content` and a final `[DONE]`. `model` must be one of the shared supported Codex models returned by `/v1/models`; when omitted, the API resolves the default from the saved main config model and falls back to `versions.cdx_model`.
  - `POST /v1/responses` — minimal OpenAI-compatible Responses API compatibility adapter for non-streaming clients. Accepts `input` as a string, a bare content-part array, or a message-style array plus optional `instructions`, maps the request onto the backend chat flow, and returns a `response` object with `output[0].content[0].type="output_text"`. Text parts plus `image_url` / `input_image` parts are supported, including base64 `data:` URLs. `stream:true` is currently rejected on this endpoint. `model` uses the same strict allowlist and default-resolution behavior as chat completions.
  - `POST /v1/completions` — legacy text completions endpoint. `model` uses the same strict allowlist and default-resolution behavior as chat completions.
  - `POST /v1/embeddings` — placeholder endpoint; returns `501` / `not_implemented` against the current backend.
  - `GET /v1/models` — lists the supported Codex model ids from the shared config/model allowlist used by the OpenAI-compatible API.
  - `GET /v1/models/{model}` — retrieves a single model object. Legacy aliases resolve to their current id; an empty or unknown id returns `404 model_not_found`.
  - `OPTIONS /v1/*` — CORS preflight for every OpenAI-compatible route; returns 204.
- Anthropic-compatible API (see [Anthropic-compatible API](#anthropic-compatible-api) section below for full details):
  - `POST /anthropic/v1/messages` — Anthropic-compatible Messages API. Accepts `messages` with `role`/`content`, optional `model`, `system` (string or text-block array), `stream`, `max_tokens`, `temperature`, `top_p`, `top_k`. System messages in the `messages` array are extracted and handled separately per Anthropic convention; a top-level `system` block array is flattened into one string. Content can be a string or an array of content blocks (text, image). Non-streaming returns an Anthropic message format response. Streaming returns Server-Sent Events with event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`. Authentication requires a Claude API key via `Authorization: Bearer sk-ant-...` or `x-api-key: sk-ant-...`.
  - `POST /anthropic/v1/messages/count_tokens` — token-count estimate for a prospective request. Takes the same `messages` / `system` / `tools` shape as `/anthropic/v1/messages` but does not require `max_tokens`, and returns `{input_tokens}`. The runner shells out to the `claude` CLI rather than a raw model endpoint, so the count is a character-based estimate and will not match the real API exactly.
  - `POST /anthropic/v1/completions` — Anthropic-compatible text completion endpoint. Accepts `prompt` and optional `model`. Returns completion in Anthropic format.
  - `POST /anthropic/v1/complete` — the upstream spelling of `POST /anthropic/v1/completions`; same handler, same body and response.
  - `GET /anthropic/v1/models` — lists available Claude models (`claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`) in the Anthropic Models API shape; Sonnet 5 is the default (Sonnet 5.5 is supported, not yet the default).
  - `GET /anthropic/v1/models/{model_id}` — retrieves a single model object; unknown ids return `404 not_found_error`.
  - `POST /anthropic/v1/responses` — Minimal Responses API compatibility adapter for non-streaming clients. Accepts `input` (string, content-part array, or message-style array) plus optional `instructions`. Maps the request onto the Claude Messages backend and returns an OpenAI-compatible `response` object. `stream: true` is rejected.
  - `POST /anthropic/v1/embeddings` — Placeholder endpoint; returns `501` / `not_implemented` as Anthropic does not support embeddings.
  - `OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions`, `OPTIONS /anthropic/v1/responses`, `OPTIONS /anthropic/v1/embeddings` — CORS preflight for Anthropic routes.
- `GET /wrapper` — wrapper bakery v2 manifest. Aliased to `GET /wrapper/v2/meta`. Returns `{engine, binaries: { "<os>-<arch>": {version, sha256, size_bytes, url_path} }, schema_version}` for the calling host's engine. Auth required.
- `GET /wrapper/download` — host-targeted legacy transition launcher (POSIX `sh`). Auth required; the transition launcher fetches the signed per-host v2 config, installs `cxx` plus the enabled relative alias under the user's data dir, and explicitly execs `cxx <engine>` with the original arguments. Date-versioned shell wrappers receive this URL with no static checksum in `/auth` and `/cron/check` so they do not overwrite themselves with a raw Go binary before config exists.
- `GET /wrapper/v2/download` — raw common `cxx` binary for the calling host's detected platform. Auth required; intended for v2-aware installers/clients that already write the signed config.
- `GET /wrapper/v2/config[?sig=1]` — signed per-host config JSON (or detached signature when `?sig=1`); ETag is the SHA256, `X-Config-Version` is the current `hosts.config_version`. The payload carries the decrypted host API key, never the at-rest SHA-256 lookup digest. `engine_options.model_catalog` (`{default_model, models: [{model, efforts, session_efforts, default_effort}]}`) mirrors the engine's model-defaults catalog for the bare-`cxx` launchpad; Claude's native session capabilities add `max` in `session_efforts`, including Opus/Sonnet 4.6 even though their persistent efforts stop at `high`. `wrapper.auto_update` is the host's effective setting (its per-host override, else the fleet default); cxx 0.9.82+ keeps its only, nightly, maintenance cron from it ([host runtime policy](host-runtime-policy.md)). Auth required and the requested engine must be enabled for the host.
- `GET /wrapper/v2/manifest/{engine}` — per-platform manifest for `codex`, `claude`, or `grok`; an unknown engine returns `404 unknown_engine`. Auth required.
- `GET /wrapper/v2/bin/{artifact}/{platform}/v:version/{binary}` — versioned binary route; the canonical common shape is `cxx/{platform}/v:version/cxx`. `{platform}` is `os-arch` (for example `linux-amd64`), the version segment is a literal `v` followed by the version, ETag = SHA256, and `Cache-Control: public, max-age=86400, immutable`. Compatible `codex|claude/.../{cdx|clx}` URLs preserve exact historical artifacts and otherwise stream the matching common bytes. Auth required.
- `GET /wrapper/v2/download/{artifact}/{platform}/v:version/{binary}` — the same exact-version artifact as `/wrapper/v2/bin/...` (same validation, headers and 404s; never another version or platform). It exists for cxx 0.9.71–0.9.74 owners, which reach it through the communicator's 307 (see `GET /host/communicator/connect`) and fetch it over direct HTTPS because the path contains `/download`. Auth required.
- `POST /cron/check` — lightweight cron auto-update probe for the host-wide `cxx-managed` job (alias cron commands forward to the coordinator). Requires host API key but intentionally skips normal host-status/IP/insecure-window gating; updates `last_cron_check` / `updated_at`, records submitted observed `client_version` / `wrapper_version` when present, accepts an optional `probe: true` for callers that are not cron — a wrapper re-resolving its engine target on the way out of an interactive session asks the same question, and stamping `last_cron_check` for it would keep the field fresh on a host whose cron has been dead for weeks, so a probe skips that write and is otherwise identical, normalizes labeled client versions such as `codex-cli 0.130.0` before comparing them to fleet targets, and returns top-level client `action` (`disable|no_update|update`) plus target version/tag metadata. Response also carries a nested common `wrapper` block (`action`, `target_version`, host-baked `sha256`, `url`) so cron can self-update `cxx` before attempting engine-client updates; v2 wrappers send `X-Wrapper-Platform: <os>-<arch>` so the response points at the matching platform artifact, legacy date-style shell wrappers get `/wrapper/download?engine=...` plus `sha256:""` for the transition launcher (an empty string, never `null`: their cron reads the field with `print(...get('sha256',''))`, which turns `null` into the string `None` and failed every launcher download as "hash mismatch"; the launcher verifies the `cxx` binary checksum itself), while v2 wrappers keep the static binary URL/checksum. For backward compatibility the top-level `action` remains client-only, so a wrapper-only update returns `action:"no_update"` with `wrapper.action:"update"`. The first upgraded legacy tick installs the one shared job and removes both `cdx-managed`/`clx-managed` system entries plus lines ending in an exact managed marker from every actual owner discovered in the standard cron spools. Strictly validated spool filenames remain eligible when the static wrapper's Go `os/user` lookup cannot resolve NSS/SSSD accounts; config-owner/sudo/current/root safeguards still require lookup validation. Privileged cleanup snapshots those crontabs and restores them all, while removing the new system entry, if any user or legacy-system cleanup step fails. With `CXX_WRAPPER_ROLLOUT_ENABLED`, the `wrapper` target is gated per host by the staged cxx rollout (`services/wrapper-rollout.ts`): a host the rollout has not admitted yet, and that does not already run the new release, gets the release it was on (`from_version`, so `wrapper.action:"no_update"`). The signed `/wrapper/v2/config` `wrapper` block applies the same gate, and the communicator updater applies a release only when both agree.
- `POST /cron/report` — cron auto-update completion report. Requires the same lightweight cron auth and at least one of `client_version` or `wrapper_version`; updates only supplied versions after a successful cron-managed update run. Select Claude or Grok via body/query `engine` or `X-Engine` so only that engine's parallel version fields are updated; other engines and omitted values are preserved. Only actual version transitions write a `cron.update_reported` audit event, including the engine; unchanged reports still update contact/version state and publish `host.updated` to refresh the console.
Host resource sync (`/skills`, `/agents/retrieve`, `/config/retrieve`) and cron routes resolve the same body/query/header engine hints as auth, including the legacy `clx` and `cgx` user-agent aliases. Invalid, conflicting, or disabled-engine requests fail before resource writes. Claude-native artifact routes default to Claude and reject explicit Codex hints. Shared Skill and instruction inheritance is unchanged.

- `GET /skills` — list registered skills (`slug`, `sha256`, `manifest_sha256`, `display_name`, `description`, `updated_at`, optional `deleted_at`, `managed`, `allow_implicit_invocation`) plus canonical `uri` / `canonical_uri` (`skill://{slug}`) and nullable provenance (`source_type`, `source_repository`, `source_path`, `source_revision`, `source_license`, `bundle_sha256`). For imported skills, `sha256` is the complete bundle digest while `manifest_sha256` remains the raw manifest digest. Auth required. This route remains available for inventory/admin-adjacent clients, but cdx reads Skill content through MCP resources instead of local sync.
- `POST /skills/retrieve` — body: `slug` (required; accepts legacy `filename`) and optional `sha256`. Returns `status` (`missing` | `deleted` | `unchanged` | `updated`), canonical `uri`, digest/provenance/managed/invocation metadata, and `manifest` when the stored content differs. Host runtimes should prefer MCP `skill://{slug}` reads.
- `POST /skills/store` — body: `slug`, `manifest` (required string; canonical Skill `SKILL.md` markdown content), optional `display_name`/`description`, optional `sha256` (validated against `manifest`). Stores/updates canonical skill specs, logs `skill.store`, and returns `status` (`created` | `updated` | `unchanged`) with canonical `sha256`. When `description` is omitted and the manifest is new/changed, the API may ask the runner to generate a short summary and persist it into `skills.description`; runner summary failures do not fail the store request. Code-managed slugs and rows with non-blank `source_type` are read-only here and reject store/delete attempts.
- Claude artifacts (host API key auth; `{kind}` is `subagent`, `command`, or `output-style`, and plural/alias spellings are accepted):
  - `GET /claude/{kind}` — list the served artifacts of that kind: `slug`, `sha256`, `display_name`, `description`, `model`, `updated_at`, `engine`.
  - `POST /claude/{kind}/retrieve` — body: `slug` (accepts legacy `filename`) plus optional `sha256` (64-hex). Returns `status` (`missing` | `deleted` | `unchanged` | `updated`) and the artifact body when updated.
- `POST /claude/usage/report` — host API key auth. The clx wrapper's fleet-owned statusLine command pushes what Claude Code's own `rate_limits` payload just reported for the account: optional `five_hour`/`seven_day` objects (`used_percent`, `resets_at`), optional `source` (defaults `statusline`). Deliberately push-only: the server holds no Claude OAuth token and calls no Anthropic/claude.ai endpoint for this (unlike `ChatGptUsageService`, which does hold and use one). A report carrying neither window is accepted (`200 {status:"ignored"}`) but stored nowhere, so a stale/absent reading never blanks out the last known one. Publishes `claude.usage.updated` on a stored report. See `GET /admin/claude/usage`.
- `POST /agents/retrieve` — pull the served agent document (`AGENTS.md` for Codex, `CLAUDE.md` for Claude). Optional `sha256` supports unchanged responses. Every render replaces a mandatory `cxx:managed-policy` prefix containing Fleet Identity, precedence/safety floor, and Hard Stop Lines, then preserves the canonical base, then replaces the `cxx:managed-features` suffix in fixed Skills, Memory, Projects, BrowserOS, Secrets, API keys in chat, Agent Messaging, Git Director, File Transfer order (a module that is off contributes no block and reports its section absent). Response metadata exposes combined `managed_sha256`, separate `policy_sha256` / nullable `features_sha256`, and mandatory section diagnostics alongside the capability sections. Feature blocks carry triggers, invariants and tool names only; Wake/Cron, Watchdog and Conference procedure lives in the managed `#wake-cron`, `#watchdog` and `#conference` Skills. Static policy modules carry craft only: anything a posture axis grants, asks for or forbids is said once, by the axis. Codex and MCP-enabled Claude Skill guidance makes MCP authoritative for fleet Skill content without overriding higher-level built-in/system Skill requirements; Memory and Secrets retain their safe read/write contracts. The served digest covers all three layers while `base_sha256` remains the canonical body digest. Missing canonical content preserves an existing local document, and per-host overrides still take precedence.
- `POST /config/retrieve` — pulls the selected engine's canonical config template and bakes a per-host Codex `config.toml` or Claude JSON config using the authenticated host context. A missing engine-specific template returns `status:missing`; Claude never inherits Codex settings. The Claude `/sync/bootstrap` settings partial remains the preferred native deep-merge path. Optional body fields `username` and `home` allow the server to append a trusted project stanza (`[projects."<home>"] trust_level = "trusted"`) to silence Codex trust warnings for the calling user. Managed MCP uses `cxx communicator mcp <engine>` for supported wrapper releases (0.9.71+), otherwise native HTTP. `X-Wrapper-Version` describes the running caller for this render; it overrides the selected engine's last stored report without persisting it or changing authentication. Missing headers retain stored-version compatibility. The same rule applies to `/sync/bootstrap` config and Claude settings, including the first sync before `/cron/report`. For a Codex host whose reported `client_version` is 0.156.1 or newer (or unreported), profiles are not rendered as `[profiles.*]` tables — that layout makes `codex --profile <name>` fail with "failed to load configuration" — but returned as a `profiles: [{name, sha256, content}]` list beside the body, one `<name>.config.toml` layer each (names limited to `[A-Za-z0-9_-]{1,64}`). The list rides every reply, including `unchanged`, and is repeated under `data`; the key is absent for older Codex builds (which keep the tables) and for Claude. The same object is returned as `config` by `POST /sync/bootstrap`.
  ```toml
  [mcp_servers.cdx]
  url = "{base_url}/mcp"
  http_headers = { Authorization = "Bearer {host_api_key}" }
  startup_timeout_sec = 30
  ```
  The baked config may include top-level `model_provider` and `local_provider` keys when set in the admin config builder.
  Secure hosts receive the managed MCP `Authorization` header backed by the host API key. Insecure hosts instead receive a short-lived MCP bearer token so the effective `${CODEX_HOME:-~/.codex}/config.toml` does not persist a reusable host credential between runs. A successfully injected Codex MCP entry also adds `[[skills.config]]` with `name = "skill-creator"` and `enabled = false`; this exact-name selector removes the competing local/system workflow without assuming a `CODEX_HOME` path. MCP-disabled/unavailable renders and Claude settings do not contain it. When `hosts.browseros_mcp_enabled=true` on a Codex host, the baked TOML also includes `[mcp_servers.browseros]` with `url = "http://127.0.0.1:9000/mcp"` and `startup_timeout_sec = 30`; this is never fleet-wide and is not injected for Claude. Fleet model defaults selected through `/admin/model-defaults/codex` are stored as the canonical `model` / `model_reasoning_effort` keys. When `hosts.model_override` / `hosts.reasoning_effort_override` are set, the baked config overrides those keys so the effective file matches the host’s defaults.
  Optional body `sha256` (64-hex) lets the server return `status:unchanged` without echoing the file. Response includes `status` (`updated` | `unchanged` | `missing`), baked `sha256`, `base_sha256` (template sha), `updated_at`, `size_bytes`, and `content` when updated. When `status=missing`, cdx should delete the effective `${CODEX_HOME:-~/.codex}/config.toml`.
- Projects module routes (host-authenticated, normal IP-binding rules, 404 when disabled):
  - `GET /projects` — returns `{ projects: [...] }` where each summary includes `slug`, `title`, `name`, `description`, `about`, `latest_seq`, `created_at`, and `updated_at`. `include_about=false` returns the compact record instead: `about` is dropped for `about_bytes` and `about_omitted:true`, and `description` is clipped to 500 characters. The MCP `project_list` tool applies that compact form by default (`include_about: true` embeds the document again) because one project's `about` can be tens of kilobytes; the HTTP route keeps `about` unless asked.
  - `POST /projects` — body: `slug` (required), optional `about` object, optional `roster_markdown` or `agents_markdown`. Returns full project detail payload.
  - `GET /projects/{slug}` — full shared state: `project` (summary/counts/seq), `notes`, `todos`, `files`, `feedback`, `memories`, and `recent_changes`.
  - `GET /projects/{slug}/summary` — lean orientation payload: `project`, `about`, `roster_markdown`, `latest_seq`, `counts` (adds `files_bytes`, `feedback_by_type`, `feedback_by_status`), `board` (compact column/open-card/your-claims block, `status: "disabled"` when the board module is off, and read-only — it never renews a claim), `files` as metadata only (no `content`), `recent_notes` and `recent_changes` as previews, `recent_memories`, managed `skill`/`instructions`/`quickstart`, and `routes`. This is the documented first call; `/bootstrap` inlines whole file bodies and is kept for compatibility.
  - `GET /projects/{slug}/bootstrap` — compact context payload: `project`, `about`, `roster_markdown`, `latest_seq`, `counts`, `recent_notes`, `recent_todos`, `recent_files`, `recent_memories`, `recent_changes`, managed `skill` metadata (`slug`, canonical `uri`), native `instructions`, native `quickstart`, and `routes`. `recent_memories` is capped at 8 and carries previews only (`preview`, `content_length`, no `content`), unlike `recent_files` which inlines full content. The embedded guidance is project-only for CoCo shared handoffs and points durable shared memory at `project_memory_*`, warning that `memory://...` remains host-scoped.
  - `POST /projects/{slug}/about` — body `{about:{...}}` or a raw object; returns `{ project, about }`.
  - `POST /projects/{slug}/archive` — optional body `{reason}`; returns `{ project, archived_at, status }` where `status` is `archived` or `unchanged`. `POST /projects/{slug}/unarchive` is the inverse and returns `unarchived` or `unchanged`. Archiving writes `coord_projects.archived_at`, which removes the project from `GET /projects` (unless `include_archived` is set) and from the MCP resource catalogue; the project stays readable and writable by slug, and `POST /projects` still refuses to reuse the slug.
  - `POST /projects/{slug}/roster` — body `{roster_markdown}` or `{markdown}`; returns `{ project, roster_markdown }`.
  - `GET /projects/{slug}/changes` — optional `since` (query/body, normalized `>=0`); returns `{ project, since, latest_seq, changes[] }`.
  - Notes: `GET /projects/{slug}/notes`, `POST /projects/{slug}/notes`, `POST /projects/{slug}/notes/{id}`, `DELETE /projects/{slug}/notes/{id}`. Create/update require `header` + `body`. Delete returns `{ project, deleted:id }`.
  - Todos: `GET /projects/{slug}/todos`, `POST /projects/{slug}/todos`, `POST /projects/{slug}/todos/{id}`, `POST /projects/{slug}/todos/{id}/done`, `POST /projects/{slug}/todos/{id}/undone`, `DELETE /projects/{slug}/todos/{id}`. Create/update require `title`; todo payloads include boolean `done` and optional `done_at`.
  - Files: `GET /projects/{slug}/files`, `POST /projects/{slug}/files`, `DELETE /projects/{slug}/files/{id}`. Upsert requires `stored_name` (or `name`) plus `content`; optional `description` and `mime_type`. Returned file payloads include `content`, `content_sha256`, `size_bytes`, `created_at`, and `updated_at`.
  - `POST /projects` accepts `board_template`: `software` (the default seven lanes) or `migration` (`backlog → discovery → plan → cutover → verify → done`, plus `blocked`). A template provisions the board eagerly at create time, because `ensureBoard` is otherwise lazy and the choice would have nowhere to wait; an unknown name is a 422 listing the valid ones.
  - Feedback: `GET /projects/{slug}/feedback`, `POST /projects/{slug}/feedback`, `POST /projects/{slug}/feedback/{id}`. Create requires `type` (`bug|feature|note|issue|test`), `title`, and `body`; new entries start with `status:"open"`. The `{id}` form patches only the fields it is given — `status` (`open|acknowledged|resolved|dismissed`), `type`, `title`, `body` — and rejects an empty patch. Until this existed `status` had a default and no writer, so nothing ever left `open`.
  - Memories: `GET /projects/{slug}/memories`, `POST /projects/{slug}/memories`, `POST /projects/{slug}/memories/search`, `GET /projects/{slug}/memories/{key}`, `DELETE /projects/{slug}/memories/{key}`. Project-scoped and visible from every host, unlike `/mcp/memories/*` below. Upsert requires `key` (`^[A-Za-z0-9._:-]+$`, ≤128 chars, never auto-generated) plus `content` (≤32k); optional `metadata` object and `tags` (≤32, ≤64 chars each). Status: `created` | `updated` | `unchanged` — an `unchanged` re-store writes nothing and records no event. The listing returns previews (`preview`, `content_length`) unless `include_content=true`; `limit` caps at 500. Search accepts an optional `query` (omit for a recency listing), optional `tags` (AND-filtered), and `limit` (≤100, default 20); the response carries `degraded:true` when the full-text index is missing and it fell back to a substring scan. Deletes are hard; `source_host_id` attributes each write, and every mutation appends to the project event log. No `coco*` reservation applies here — that reservation exists to redirect callers to this surface.
- MCP memories (host API key auth, or short-lived insecure-host MCP bearer auth) remain host-scoped and are not valid for CoCo cross-server handoffs — use the project memories above for coordination state tied to a workstream, or the shared memories below for fleet-wide reference documents:
  - `POST /mcp/memories/store` — body: `content` (required string, ≤32k chars), optional `id`/`memory_id`/`key` (slug/UUID; generated when omitted), optional `metadata` (object), optional `tags` (up to 32 strings, ≤64 chars each). Status: `created` | `updated` | `unchanged`; echoes `memory` (`id`, `content`, `metadata`, `tags`, nullable `summary`, `created_at`, `updated_at`). On create/update, the API may ask the runner to generate a short one-sentence summary for admin/API presentation; runner failures do not fail the memory write, and unchanged writes with a missing summary remain eligible for backfill. Served agent documents never enumerate these rows or summaries. Keys matching `^coco(?:$|[._:-])` are reserved and rejected so CoCo shared handoffs must go through Projects.
  - `POST /mcp/memories/retrieve` — body: `id`|`memory_id`|`key` (required). Returns `status:found|missing` plus `memory` when present. Reserved `coco*` keys are rejected.
  - `POST /mcp/memories/search` — body: `query`/`q` (string; empty lists recent), optional `limit` (1–100, default 20), optional `tags` (filter requires all provided tags). Matches are ranked by MySQL full‑text score when `query` is set; response includes `matches` with `score` (nullable) and full `memory` payloads.
  - `POST /mcp/memories/delete` — body: `id`|`memory_id`|`key` (required). Returns `status:deleted|missing`. Reserved `coco*` keys are rejected.
  - `DELETE /mcp/memories/{id}` — deletes by memory key (URL decoded); response matches `POST /mcp/memories/delete`.
- Shared memories (host API key auth and the same IP rules) are the fleet-wide corpus: one row per `slug`, readable and writable from every host and either engine, and scoped to neither host nor project. `source_host_id`/`source_engine` record who wrote last but never filter reads. Documents run to 1 MiB and are chunked for retrieval, so listings and searches return previews and passages rather than bodies. No `^coco` key reservation applies here:
  - `GET /shared-memories` / `POST /shared-memories/list` — the discovery entry point; needs no query. Query/body: optional `prefix` (slug prefix), optional `tags` (AND-filtered), optional `limit` (1–200, default 50, clamped to 20 when `include_content` is set — bodies run to 1 MiB each), `offset`, `include_content` (default false). Returns `count`, `total` (live documents), `scanned_all` (false when the 2000-document scan cap was hit before filtering finished), and `memories` — each with `slug`, `title`, `summary`, `tags`, `metadata`, `content_length`, `chunk_count`, `revision`, `sha256`, `uri` (`shared://{slug}`), `source_host_id`, `source_engine`, timestamps, and a whitespace-collapsed `preview` (the summary when set, else the body).
  - `POST /shared-memories/search` — body: `query` (empty falls back to a recency listing rather than erroring), optional `tags` (AND-filtered), optional `mode` (`chunks` default, or `documents`), optional `limit` (1–50, default 10). Ranked by MySQL full-text score over chunk text, headings and tags. `chunks` mode returns one entry per passage (`slug`, `title`, `uri` `shared://{slug}#{ordinal}`, `chunk`, `heading`, `excerpt` windowed around the match, `score`, `char_start`, `char_end`); `documents` mode returns one entry per document with its best `score` and up to three `hits`. The response carries `degraded: true` when the chunk full-text index is missing and it fell back to a bounded substring scan (the first 64 KiB of each of at most 200 documents — a match past that prefix is missed, which is an accepted loss on an already-degraded path). Note MySQL's defaults: tokens shorter than `innodb_ft_min_token_size` (3) and stopwords match nothing, which is indistinguishable from no results.
  - `POST /shared-memories/read` / `GET /shared-memories/{slug}` — body/query: `slug` (required in the POST form), optional `max_chars` (default 32000, up to 1048576), optional `offset`, optional `chunk` or `from_chunk`/`to_chunk`. Returns `status` (`found` | `missing`), `memory` metadata, a bounded `content` window, plus `offset`, `returned_chars`, `truncated`, `next_offset`, and `chunk_range` — enough to walk a 1 MiB document without ever holding all of it.
  - `POST /shared-memories/write` — body: `slug` (required, `^[a-z0-9][a-z0-9._:-]*$`, ≤160 chars, lower-cased on write), `content` (required, ≤1048576 chars), optional `title` (≤255, defaults to the slug), `summary` (≤1000), `metadata` (object), `tags` (≤32, ≤64 chars each), `engine` (provenance only), and `expected_sha256`. When `expected_sha256` is supplied and does not match the stored digest the write is rejected with `409 shared_memory_conflict` instead of clobbering a concurrent writer. The digest check and complete replacement run under the same per-slug database lock used by append, so distinct concurrent replacements from one digest cannot both succeed; writes without a digest retain last-writer-wins semantics. Status: `created` | `updated` | `unchanged` — an `unchanged` re-store writes nothing and burns no revision.
  - `POST /shared-memories/append` — body: `slug` and `content` (required), optional `heading` (rendered as an `## ` block), `separator` (default `\n\n`), `title`, `summary`, `tags`, `metadata`, `engine`. Creates the document when the slug is absent. This is the multi-writer-safe path: two agents appending concurrently both keep their text, where a read-modify-write pair would silently drop one. Tags are unioned, not replaced. Status: `created` | `appended` | `unchanged`, plus `appended_chars`.
  - `POST /shared-memories/delete` / `DELETE /shared-memories/{slug}` — soft-deletes the document and drops its chunks; the slug stays reserved and a later write revives it. Returns `status` (`deleted` | `missing`).
- `GET /mcp` — transport probe; returns 405 with `Allow: POST`.
- `POST /mcp` — the JSON-RPC 2.0 transport itself (single call or batch). Methods include `initialize`, `tools/list`, `tools/call`, resource operations, and dot aliases. `initialize` returns server-wide instructions requiring clients to inspect deferred catalogs rather than infer tool absence and to probe secrets capability through read-only `secret_list`. Skill reads honor `X-Engine`; host `skill_store`/`skill_delete` mutate only shared manifest-only Skills and reject managed/source-owned rows.
- Streamable HTTP MCP endpoint (`/mcp`, protocol `2025-03-26`) authenticates in `resolveHost()` (`api/src/routes/mcp/index.ts`): the presented credential is first checked as a short-lived MCP session token (`McpSessionService.verify`) and otherwise resolved as a host API key (`app.resolveHostFromKey`), after which non-`active` hosts are rejected. It advertises host-safe `memory_*`, `shared_memory_*`, `skill_list`, `skill_retrieve`, `skill_store`, `skill_delete`, `resource_*`, `project_*` (including the board's `project_board_list` / `project_card_*`), `secret_*`, `git_*`, and `transfer_*` tools; `docs/MCP.md` is the per-tool catalog. The module-gated families stay listed while their module is off and answer `status:"disabled"` from their list/probe tool, so an agent can tell "off" from "empty". Coordinator filesystem helpers (`fs_*`) remain operator-only and are neither exposed nor dispatchable to host callers. Tool names use underscores to satisfy `^[a-zA-Z0-9_-]+$`; `tools/call` still accepts dot aliases for backward compatibility.
  - MCP resources: `resources/templates/list` returns templates `memory_by_id` (`uriTemplate: memory://{id}`), `memory_store` (`uriTemplate: memory://{scope}:{name}`), `skill_manifest` (`uriTemplate: skill://{slug}`), `skill_file` (`uriTemplate: skill://{slug}/{path}`), and `shared_memory` (`uriTemplate: shared://{slug}`); when the Projects module is enabled it also returns `project_bootstrap` (`uriTemplate: project://{slug}`). `resources/list` enumerates recent memories for the calling host (up to 20), the 50 most recently updated shared memories as `shared://{slug}` markdown resources, canonical Skills as `skill://{slug}` markdown resources, up to 128 support files per source-owned skill as `skill://{slug}/{path}`, and, when enabled, active shared projects as `project://{slug}` resources. A manifest with `disable-model-invocation: true` is described as `[Explicit user invocation only]`; this policy is not silently widened by import. `resources/read` fetches a single memory as `text/plain` when given `uri=memory://{id}`, a shared memory body as `text/markdown` when given `uri=shared://{slug}`, a Skill manifest as `text/markdown` when given `uri=skill://{slug}`, an exact support file when given `uri=skill://{slug}/{path}`, or a project bootstrap JSON document when given `uri=project://{slug}`. Bundled manifests receive a read-time note pointing relative references at the MCP file URI and warning that bundled scripts are reference text, not execution authority. `resources/create`/`update`/`delete` accept `shared://{slug}` as well, though that path carries only text. Existing shared documents require a complete offset-zero read with one stable digest and `expected_sha256` before either whole-body resource replacement, while delete is reserved for a wholly invalid or superseded record. `shared_memory_write` remains the full-fidelity surface and the only one that records an engine. CoCo coordination state still lives only in project resources.
- `GET /versions` — version snapshot (no auth; `503 api_disabled` while the `api_disabled` flag is set). Optional query `engine` or `X-Engine` selects Codex, Claude, or Grok (Codex by default); invalid or conflicting hints return `422`. The envelope `data` is the selected engine's `VersionSnapshot` of `api/src/services/version-snapshot.ts`, as codified in `versions.schema.json`. Keys: `client_version`, `client_version_override`, `client_version_enforce_exact`, `client_version_fetched_at`, `wrapper_version`, `wrapper_sha256`, `wrapper_url`, `runner_state`, `api_disabled`, `auto_update_enabled`, `cdx_silent`, `clx_silent`, `cgx_silent`, `agent_messaging_enabled`, `fleet_disabled_engines`, `installation_id`, `engine`. `fleet_disabled_engines` lists the engines switched off fleet-wide (see [Engine master switches](#engine-master-switches)). Claude client targets never inherit legacy unsuffixed Codex version rows; absent Claude policy yields `client_version:null` until a Claude target is configured. Wrapper metadata comes from the v2 `BinaryRegistry` (canonical platform `linux-amd64` under `storage/wrapper/v2/bin/cxx/linux-amd64/v<version>/cxx`); clients cannot publish. The fleet target has an internal minimum floor of `0.125.0`; `client_version_enforce_exact=true` means an admin pinned an above-floor version that wrappers should match exactly, while `false` means the target is floor-only and wrappers must not downgrade to meet it. `auto_update_enabled` is the fleet default on this public endpoint; host-authenticated auth, sync, and cron responses apply the host override (`null` inherits, `0` disables, `1` enables). It controls background binary updates for all three engines; cxx 0.8.2 launches never install inline. `client_version_fetched_at` is when the upstream release metadata behind an aliased (`latest`/`auto`) target was last fetched, or `null` when the target is an explicit pin that never consults that cache; the cache has a one-hour TTL and, when an upstream fetch fails, the expired value keeps being served rather than breaking updates — so an old `client_version_fetched_at` is the signal that the fleet is being handed a stale target.
- `GET /healthz` — unauthenticated liveness probe: `{ok:true, ts}`.
- `GET /readyz` — unauthenticated derived readiness probe; returns 503 until migrations, runner, encrypted signer, complete four-platform wrapper matrix, and Public Base URL checks pass. `/healthz` remains liveness-only.
- `GET /admin/setup/status` — public only before the first admin exists, then session-gated; returns secret-free readiness (the `database` check is a live `SELECT 1`; when it fails every other database read is skipped and reported instead of 500ing), `configured_engines`, `default_engines` (the wizard's engine answer when non-empty, else `configured_engines`; drives the `auth_<engine>` next actions), verified canonical-auth presence, host/sync counts, warnings, and next actions (`auth_<engine>`…, `fleet_defaults` — complete once a Codex `client_config_documents` row exists, links `/admin/setup?step=defaults` — then `first_host`, `first_sync`).
- `POST /admin/setup/owner` — serialized one-time empty-install claim; creates a fixed active owner and returns an authenticated session cookie.
- `GET /admin/setup/wizard` — first-run wizard progress (`completed_at`, `dismissed_at`, `last_step`, `engines`); same visibility rule as `/admin/setup/status`, and mirrored there as `wizard`.
- `POST /admin/setup/wizard` — merge-update of that blob (`last_step?`, `engines?`, `completed?`, `dismissed?`). Stored in the `versions` K/V table without publishing `settings.changed`, because step position is not a setting anything should react to. Separate from `setup_complete`, which covers only infrastructure and the owner claim and therefore goes true at step two of nine.
- CLI device auth — the `cdx`/`clx` device-code login flow, which mints a host without an admin-issued installer token:
  - `POST /cli/auth/start` — wrapper begins a login. Body: `fqdn`, optional `secure` (default `true`). Returns the request id, the user code, and `verify_url`. Exempt from the API kill switch.
  - `POST /cli/auth/poll/{id}` — wrapper polls the 64-hex request id until approved or denied; an approved response also carries `base_url`. Unknown ids return `404`.
  - `GET /cli/auth/verify` — browser approval page read from `STATIC_ROOT`. This is the one route that reads `ADMIN_ACCESS_MODE`: anything but `open` requires an admin session.
  - `POST /cli/auth/lookup` — admin session required; `{user_code}` resolves a pending request (`404` when unknown or expired).
  - `POST /cli/auth/approve` — owner/admin role required; `{user_code}` approves the request and registers the host. Approval can rotate an existing host credential, so it shares the Agent Messaging generation-fencing gate.
  - `POST /cli/auth/deny` — admin session required; `{user_code}` denies the request.

Auth verification worker: when `AUTH_RUNNER_URL` is configured, the API starts a background verifier on boot and wakes it every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300). It re-probes the latest Codex, Claude, and Grok canonical payloads (Grok through the metadata-only `/verify-grok` probe, never spending its refresh token) on a dynamic schedule — the re-check interval equals the credential's proven-good age, clamped between `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900) and `AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS` (default 21600); successful gateway execs count as proof and advance the clock without a probe — records `verification_state`, and updates per-engine runner telemetry without making wrapper startup wait on the runner. Runner failures are logged/surfaced and do not block `/auth` retrieve, but every canonical-auth-changing upload, including admin and seed uploads, requires a configured, reachable runner and a positive live verdict.

## Installer

- `GET /install/{token}` — credential-free preflight launcher for a pre-registered host's single-use installer; it consumes nothing. Every token/host gate below runs (errors as for the claim), then it returns a small POSIX script without the API key that checks `python3`, `curl`, and a writable bin root (or `sudo -n`). A failed check prints the fix, states that the installer was not consumed, and exits 1 without contacting the server again, so the same command can simply be re-run. Once the checks pass it claims the installer with `POST` to the URL it was fetched from (`curl -fsSL -X POST`, honouring `CODEX_INSTALL_CURL_INSECURE`), writes the result to a `mktemp` file (0600, removed on exit), runs it with `sh`, and exits with its status.
- `POST /install/{token}` — claims the single-use installer: re-runs every gate, atomically marks the token used (`WHERE used_at IS NULL`, so concurrent claims serve one script), logs `install.v2.token.consume`, and emits the full installer script. Tokens minted via `/admin/hosts/register` or `/admin/hosts/{id}/installer` (one pending token per host; issuing a new one deletes prior pending tokens), expire after a TTL fixed at 1800s in the API (no env knob), and embed the resolved public base URL (from token metadata, `PUBLIC_BASE_URL`, or trusted forwarded Host/proto) plus the API key/FQDN into the selected installer mode. Registering an existing FQDN rotates the API key; the host-detail mint endpoint reuses the current encrypted key. The installer fetches all enabled configs first and requires identical common version/SHA metadata, installs one `cxx`, and atomically replaces legacy regular wrappers with relative `cdx`/`clx` aliases for enabled engines. Claude-capable modes preflight Node.js/npm: supported package managers provide Node, a pinned Corepack npm 10.9.2 shim is preferred when npm is absent, and the OS npm package is the fallback. Before printing its header it preflights `python3`, `curl`, and a writable bin root (or `sudo -n`), printing one failure line with the fix for each and exiting 1. It invokes the host-wide `cxx cron install` and `cxx cron run --minimal` paths exactly once each, then runs one non-fatal `cdx`/`clx --allow-concurrent-sync sync </dev/null` per enabled engine (bounded by `timeout 60` when available; a failure is a warning with the retry command, never `INCOMPLETE`). It prints `READY` only after `cxx`, every requested CLI, and cron setup verify; otherwise it prints `INCOMPLETE`, names direct retry commands (`cdx cron install` / `cdx cron run`, `clx` on Claude-only hosts), and exits non-zero. It never auto-launches an interactive engine. For hosts with `curl_insecure=true`, internal downloads default to `curl -k`; the copied command also includes `curl -k` plus `CODEX_INSTALL_CURL_INSECURE=1`. Consuming a token (the `POST`) publishes `host.updated` (`{id, fqdn, engine}`). On both methods, used/expired/missing tokens and build failures return HTTP 200 with `X-Installer-Error: <code>` (`installer_not_found`, `installer_used`, `installer_expired`, `installer_host_missing`, `installer_base_url_invalid`, `installer_build_failed`) and a script that prints the message to stderr and exits 1, so `curl -fsSL … | sh` shows it instead of piping an empty body.
  The per-user `cxx-agent` background worker is installed by `cxx cron run`
  itself, not by a separate installer call, and from cxx 0.9.82 only on a
  persistent host; elsewhere an existing unit is disabled, stopped and removed.
  Where it runs it remains present with messaging disabled and, on
  Claude-capable hosts, uploads changed native auth generations written by
  detached daemons; on other hosts those are uploaded at the next wrapper run.
  The `# cxx-managed-cron` maintenance line is installed only when the host's
  effective `wrapper.auto_update` is on, and then runs nightly. See
  [host runtime policy](host-runtime-policy.md).
- `GET /install/v2/{token}`, `POST /install/v2/{token}` — aliases of `GET /install/{token}` and `POST /install/{token}`; wrappers minted against the v2 URL keep working unchanged (the v2 launcher claims via the v2 URL).

## Admin (admin session cookie)

The Model defaults tab of the Engines page (`/admin/engines#defaults`, formerly the Quick Settings page, whose URL now redirects) reuses `GET/POST /admin/model-defaults/{engine}` for immediate saves. Model choices and effort segments come from the returned catalog; selecting a model submits its `default_effort` together with the model, including `null` for models without effort control. Grok also offers context-window buttons from `context_windows`, preserving the chosen size across model and effort changes. The per-engine tabs keep explicit Save controls. Both surfaces edit the same fleet defaults and receive existing settings invalidations.

- Admin URLs that are both Svelte routes and JSON endpoints return the SPA shell when a browser navigation sends `Accept: text/html`; API clients must continue to send `Accept: application/json` to receive JSON from colliding paths such as `/admin/hosts`, `/admin/projects`, project detail slugs and their `notes` / `todos` / `files` / `feedback` tabs, and `/admin/users`.
- `GET /admin/overview` — hosts count, avg refresh age, latest log timestamp, versions (runner/quota flags included), ChatGPT usage snapshot (cached ≤5m) plus `chatgpt_usage_summary` (lane-oriented normal/spark windows), `chatgpt_cached`/`chatgpt_next_eligible_at`, quota controls (`quota_limit_percent`, `quota_week_partition`), `cdx_silent`, `admin_theme`, `reverse_dns_enabled`, `insecure_approval_enabled`, `inactivity_window_days`, optional Codex version pin metadata (`client_version_lock`, `client_version_lock_updated_at`).
- `GET /admin/ws/info` — websocket bootstrap for admin live updates. Returns `enabled`, `url`, `last_event_id`, `heartbeat_seconds`, and `backlog_limit`. When enabled, clients connect to the provided `ws/wss` URL (`/admin/ws`, admin session required) and receive one frame per published event, exactly as `api/src/ws/publisher.ts` writes it: `{ type, payload, ts }`. The server also sends `{ type: "hello", ts }` on connect and, every `heartbeat_seconds`, re-resolves the session and sends `{ type: "ping", ts }` — or closes the socket when the session is gone. The socket is push-only: it reads nothing from the client, so there is no request/response envelope.
  - The event-type catalog is the exported list in `api/src/ws/events.ts`, kept in lock-step with the frontend's `lib/ws/events.ts` by `api/test/unit/ws/event-invalidation-coverage.test.ts`. Families: logs (`log.*`), hosts (`host.*`), users, projects (`project.*` including the board's `project.card.*`), authoring (`agents.stored`, `skill.*`, `memory.*`, `shared_memory.*`, `claude_artifact.*`), provider keys, fleet secrets (`secret.*`), `settings.changed`, agent portal (`agent_portal.*`), agent messaging (`agent_messaging.*`), Git Director (`git_director.*`), file transfer (`transfers.changed` plus the operator actions `transfers.module_toggled` / `transfers.limits_changed` / `transfers.deleted`), usage, passkeys, the insecure window (`insecure.*`) and `toast`. Audit-only facts such as a secret reveal or a transfer download are recorded with `broadcast:false` and never appear on the socket.
  - Admin clients route published event types into targeted query domains
    (logs, hosts, projects, knowledge, access, fleet settings, messaging, and
    portal state) instead of full-page reloads. Unknown event types do not
    trigger a speculative refresh.
- Settings mutations now emit explicit log actions for push fanout: `admin.api.state`, `admin.cdx_silent`, `admin.theme`, `admin.reverse_dns`, `admin.insecure_approval`, `admin.codex_version`, `admin.quota_mode`, and `admin.prune_policy`.
- `GET /admin/auth/status` — admin auth status (`has_users`, `admin_count`, `enforced`, `authenticated`, `user`, `capabilities`, `authorization_mode`, `passkeys_registered`, and `passkey_login_available`). `capabilities` is the session's effective set under the fleet's current `authorization_mode` (`compatible` | `strict`) — the console's only source for which controls to show, and presentation only: the server re-checks every request against `api/src/security/route-capabilities.ts`.
- `POST /admin/auth/login/method` — username-first admin login probe. Body `{username}`; returns `{method:"passkey"|"password"}` for a known active user. Unknown/inactive usernames fail with the same generic auth-style error used by password login.
- `POST /admin/auth/login` — login with `{username, password}`; issues an HTTP-only session cookie. Users with registered passkeys cannot use this route and must complete passkey login instead.
- `POST /admin/auth/logout` — clears the session cookie.
- `POST /admin/auth/password/change` — authenticated self-service password change. Body `{current_password, new_password, confirm_password}`; rejects wrong current passwords and confirmation mismatches, applies the existing admin password policy to `new_password`, updates the current user’s password hash, expires outstanding reset tokens, and signs out other sessions for that same user while keeping the current session active.
- `POST /admin/auth/passkey/login/options` — begin passkey login. Body `{username}` returns WebAuthn `challenge`, `rpId`, `timeout`, `userVerification:"required"`, and `allowCredentials` for that active user only. Body `{}` is accepted only when exactly one active admin user exists and that user has passkeys, enabling `/admin/login` to open the passkey prompt directly. Fails when the user is unknown/inactive, the single-user shortcut is ambiguous, or no passkeys are registered.
- `POST /admin/auth/passkey/login` — completes passkey login. Validates RP ID, exact origin, `UP`, `UV`, signature, challenge single-use, and credential ownership before issuing the normal admin session cookie. Sign-counter regressions log `admin.auth.passkey.sign_count_regression` and do not reduce the stored counter.
- `POST /admin/auth/passkey/register/options` — begin passkey registration for the authenticated admin session. Returns WebAuthn registration options with `residentKey:"discouraged"`, `userVerification:"required"`, and exclude-credentials built from that user’s existing passkeys.
- `POST /admin/auth/passkey/register` — completes passkey registration. Body is `{response: PublicKeyCredentialJSON, name?: string}`; raw `PublicKeyCredentialJSON` bodies from stale clients are normalized for compatibility. Validates RP ID, exact origin, challenge single-use, `UP`, `UV`, `AT`, and supported COSE algorithms before storing the public key and metadata.
- `GET /admin/login` — standalone Svelte admin login page served by the admin SPA shell.
- `GET /admin/password/reset?token=...` — standalone password-reset page linked from recovery email.
- `GET /admin/hosts/{id}` — dedicated admin host detail page (HTML shell). Uses the same dashboard assets but resolves the active host from the path instead of opening an in-page modal.
- `GET /admin/skills/new` — dedicated admin skill-create page (HTML shell route inside the admin dashboard). The direct Skills workspace is the registry, and new/edit open routed workspaces instead of a modal.
- `GET /admin/account/password` — dedicated authenticated account password page (HTML shell route inside the admin dashboard). The navbar brand/account menu links here for self-service password updates.
- `GET /admin/account/passkeys` — dedicated authenticated account passkeys page (HTML shell route inside the admin dashboard). The navbar brand/account menu links here for personal passkey registration, rename, and removal.
- `POST /admin/auth/password/request` — public recovery request. Body accepts `{username}` or `{email}`; the response is uniform to prevent account discovery. Matching active accounts receive a one-hour, single-use link to `/admin/password/reset`.
- `POST /admin/auth/password/reset` — consumes `{token, new_password, confirm_password}`, enforces password policy, rotates the password hash, expires the user's sessions and other reset tokens, and removes that user's passkeys so password login is available after recovery.
- `GET /admin/passkeys` — list the authenticated admin user’s registered passkeys (`id`, `name`, `transports`, `created_at`, `last_used_at`). Used by the `/admin/account/passkeys` page; this is no longer presented inside the Users panel.
- `POST /admin/passkeys/{id}/name` — rename one of the authenticated admin user’s passkeys. Body `{name}`.
- `DELETE /admin/passkeys/{id}` — delete one of the authenticated admin user’s passkeys.
- `GET /admin/users` — list admin users (id, name, username, email, access_level, active, last_login_at, timestamps).
- `POST /admin/users` — create user `{name, username, email, access_level, password, active?}`. Reachable without a session only while the user table is empty (`capability-after-bootstrap`), and the first user must be `owner` or `admin`; `POST /admin/setup/owner` is the preferred empty-install claim.
- `POST /admin/users/{id}` — update user fields (name/username/email/access_level/active/password).
- `DELETE /admin/users/{id}` — delete user (blocked if it would remove the last active admin).
- `POST /admin/users/wipe` — delete all users (confirmation required; returns to userless mode).
- `POST /admin/toasts` — emit an admin toast via websockets. Body: `{ message: string, title?: string, level?: "info"|"success"|"warn"|"error", timeout_ms?: number }` (aliases `body`/`text`, `tone`). Returns the created admin event.
- `GET /admin/hosts` — list hosts with canonical digest, digests history, versions, API calls, IPs (`ip4` and `ip6` when a dual-stack host binds both families), roaming flag, security flag (`secure`), VIP flag (`vip`), configured `engines` plus the parsed `engines_list`, insecure window fields (`insecure_enabled_until`, `insecure_grace_until`, `insecure_window_minutes`), `curl_insecure` (true = bake wrapper with TLS verification bypass for host sync), `browseros_mcp_enabled` (true = bake BrowserOS MCP for this Codex host), per-host overrides (`client_version_override`, `claude_client_version_override`, `agents_document_id_override`, `lane_preference`, `model_override`, `reasoning_effort_override`, `claude_model_override`, `reverse_dns_mode`, `auto_update_override`), `auth_outdated` (true when host digest differs from the current canonical auth), `auth_source` (true when the host last submitted the current canonical auth.json), recorded users (username/hostname/first/last seen), and derived auto-update telemetry: `effective_auto_update_enabled`, `auto_update_state`, `auto_update_label`, `auto_update_emoji`, `auto_update_rank`, `auto_update_last_event_at`, and `auto_update_target_version`, plus `installer_used_at` / `installer_expires_at` from each host's latest install token (`null` when it has none; read in one query for the whole list).
  Each row also carries `engine_readiness`, keyed by `codex`, `claude` and `grok`. Entries contain `state` (`ready|attention|inactive`), `reasons` (`auth_missing`, `cli_unknown`, `cli_outdated`, `wrapper_unknown`, `wrapper_outdated`, `not_assigned`, `fleet_disabled`), `cli_version`, `cli_target`, `wrapper_version` and `wrapper_target` (versions/targets are nullable strings). Readiness uses the reported installed versions, host pins over fleet locks/targets, and the existing shared-wrapper fallback. Exact CLI targets require matching semver precedence; other CLI and wrapper targets accept equal or newer versions. Unknown/unparseable versions warn. Secure hosts require an engine-local recorded auth digest; its age or difference from canonical auth does not prevent readiness. Insecure hosts skip auth checks. Unassigned or fleet-disabled engines are inactive. This endpoint reads cached target metadata only, without provider probes or queries per host.

- `GET /admin/hosts/insecure` — list insecure hosts only (no secure hosts). Returns `count`, `active` (how many have `insecure_enabled_until` in the future), `hosts` with `id`, `fqdn`, `active`, `secure`, and `insecure_enabled_until` (RFC3339, timezone-aware), plus `domains` (`id`, `domain`, `active`, `enabled_until`, `window_minutes`), `domains_active`, and `fleet_window`. `domains` includes only unrevoked rules whose `enabled_until` is in the future; a permanent rule (`enabled_until: null`) is currently left out of both the list and the count. Intended for quick UI actions (e.g. enable/disable buttons).
- `POST /admin/hosts/insecure/extend` — bulk-extend all currently active insecure windows by each host’s configured duration.
- `POST /admin/hosts/insecure/disable-all` — bulk-close all active insecure windows, expire active domain auto-allows, and retract the fleet window.
- `POST /admin/hosts/insecure/window` — open the fleet-wide insecure window for `duration_minutes` (5–1440, default 480). Auto-allows every insecure host until the deadline and resolves the pending approval queue.
- `POST /admin/hosts/insecure/window/close` — close the fleet window and everything standing behind it.
- `POST /admin/hosts/register` — owner/admin role required. Mint a host + single-use installer token for a given FQDN; calling it again for the same FQDN rotates that host’s API key, deletes prior pending installers, generation-fences any Agent Messaging runtime for the former credential, and issues a fresh one. Optional body `secure` (default `true`) marks the host as secure vs. insecure (ephemeral auth); optional body `vip` (default `false`) flags the host as VIP immediately (always warn on quota). Optional body `temporary` (boolean): when `true`, enables sliding expiry (2 hours since last successful host contact) by setting `expires_at`; each authenticated host request refreshes it. When `false`, clears any previous `expires_at`. Optional body `curl_insecure` (boolean): when `true`, bakes the host's signed wrapper config with `allow_insecure: true` (TLS verification bypass for sync), returns an installer command using `curl -k`, and makes the installer reuse `curl -k` for its own downloads. Optional body `daemon_enabled` (strict boolean) stores persistent-daemon enablement before returning the installer. New hosts use the canonical daemon defaults; re-registration changes only enablement, preserving the configured service user and limits. Omission preserves existing daemon configuration (new hosts remain disabled). The New Host/setup UI defaults this option off. Installation uses the existing Linux/systemd wrapper-sync path and requires root and eligible Agent Messaging; enablement alone is not readiness. A configuration/audit failure returns an error rather than installer success; host registration may already have occurred. Optional body `reverse_dns_mode` (`global` | `enabled` | `disabled`) sets the per-host override for reverse DNS enforcement. Optional body `engines` selects `codex`, `claude`, or both for the host and drives installer minting mode. Optional body `duration_minutes` (integer 0–480) applies when `secure=false` and sets the initial insecure window duration (and persisted `insecure_window_minutes`) for the new/rotated host; when omitted, insecure registration keeps the default 30-minute provisioning window and stored 10-minute extension duration. Installer tokens capture the public base URL (trusted Host/proto or `PUBLIC_BASE_URL`) and return installer metadata with `mode` (`codex`, `claude`, `both`) plus a human label; creation fails if no valid base is available.
- `POST /admin/hosts/quick-register` — mint an insecure temporary throwaway host without a supplied FQDN. Body requires `engines` (any nonempty combination of `codex`, `claude`, and `grok`) and accepts optional `duration_minutes` (integer 0–480). The server generates a short `tmp-YYYYMMDD-HHMMSS-xxxxxx` name, sets `secure=false`, `vip=false`, `curl_insecure=false`, and `expires_at` to 2 hours ahead, then returns the same host + installer metadata shape as `/admin/hosts/register`.
- `GET /admin/hosts/{id}/detail` — single-host detail card: the host row plus per-engine version summaries, available client versions, canonical auth metadata, and the global `auto_update_enabled` / `reverse_dns_enabled` / `inactivity_window_days` context. The host object carries `installer_used_at` / `installer_expires_at` from its latest install token (both `null` when none). Unknown ids return `404 host_not_found`. This is the JSON payload behind the `/admin/hosts/{id}` page.
- `GET /admin/hosts/{id}/auth` — canonical digest/last refresh, recent digests, optional `auth` body (`?include_body=1`). Engine selection follows the same request-body/query/header resolution as host-facing routes and defaults to `codex`; the response includes the selected `engine`, engine-specific canonical digest/refresh, engine-scoped `recent_digests`, and the full host block still includes the Codex, Claude, and Grok host fields (`last_refresh`/`auth_digest`, `claude_last_refresh`/`claude_auth_digest`, and `grok_last_refresh`/`grok_auth_digest`, each engine's client/wrapper version pair, `claude_client_version_override`, and `engines`).
- `POST /admin/hosts/{id}/installer` — re-mint a single-use installer token for an existing host without rotating its API key. Optional body `engines` targets any combination of the three engines, and optional body `curl_insecure` atomically updates the host's curl-insecure flag before minting so the returned copied command reflects the visible Host Detail toggle state. When omitted, the installer uses the host's stored engine set and current `curl_insecure` flag. The endpoint deletes prior pending installer tokens for that host and returns `{host, installer}` with the same installer metadata shape as registration. Hosts whose encrypted API key is unavailable return `409 host_api_key_unavailable`.
- `POST /admin/hosts/{id}/engines` — replace the host engine switch set. Body: `{engines:["codex"|"claude"|"grok", ...]}`; at least one engine is required. The stored value is canonicalized as a comma-separated list in `codex,claude,grok` order (for example `codex`, `claude,grok`, or `codex,claude,grok`). Disabled engines are rejected on host-facing engine-scoped routes with `403 engine_disabled`; the next successful `cdx`/`clx`/`cgx` run reconciles the peer wrappers locally.
- `POST /admin/hosts/{id}/secure` — toggle the host’s security mode (`secure:
  true` keeps native auth locally; `false` makes the last exiting auth-aware
  cdx/clx process purge credentials while retaining explicit logout intent).
- `GET /admin/wrapper/rollout` — staged cxx rollout status (`hosts.read`): `enabled`, configured `settings` (`stages`, `soak_minutes`), the current `rollout` (state plus `stage`, `next_stage`, `soak_ends_at`, `confirmed_host_ids`) or `null`, and every host's `canary` / `excluded` / `running` / `admitted`.
- `POST /admin/wrapper/rollout/:action` — `halt` (optional `reason`), `resume` (restarts the current stage's soak), `promote` (next stage now) or `complete` (release to every host now); `hosts.manage`. Returns the status body; `409` when no rollout is active or halted. Halting never reverts an updated host.
- `POST /admin/hosts/:id/wrapper-canary` — `{enabled: boolean}`; marks a host as a rollout canary (`hosts.manage`). A canary added during a rollout is admitted immediately.
- `POST /admin/hosts/{id}/vip` — toggle VIP status (`vip: true` means quota kill switch is never enforced for this host; warn-only even when the global policy is deny).
- `POST /admin/hosts/{id}/scaling-exempt` — toggle `scaling_exempt` so the host is ignored by the scaling rules read/written through `/admin/scaling`.
- `POST /admin/hosts/{id}/auto-update` — set the per-host auto-update override. Body: `{override: true|false|null}`; `null` follows the fleet `/admin/auto-update` setting.
- `POST /admin/hosts/{id}/browseros-mcp` — toggle BrowserOS MCP for one host. Body: `{ "browseros_mcp": true|false }`. When enabled, the next Codex config sync injects `[mcp_servers.browseros]` for `http://127.0.0.1:9000/mcp` and `cdx` shows a BrowserOS startup chip.
- `POST /admin/hosts/{id}/insecure/enable` — for insecure hosts only; opens a sliding window where `/auth` calls are permitted. Optional JSON body `duration_minutes` sets the window length (integer 0–480, defaults to the last stored value or 10). Each `/auth` call extends the window by the configured duration.
- `POST /admin/hosts/{id}/insecure/disable` — closes the window immediately and clears any grace; retrieve-style insecure-window-gated calls are denied until re-enabled, while `/auth` `store` remains eligible under normal auth/IP/reverse-DNS/installation/runner validation rules.
- `GET /admin/insecure-approval` — returns `{ enabled: bool }` for the insecure-host approval gate (`/admin/policies`).
- `POST /admin/insecure-approval` — enable/disable insecure-host approval gate (`enabled` boolean).
- `GET /admin/insecure-approvals/pending` — list unresolved insecure approval requests for the admin queue. Returns `requests[]` with `id`, `host_id`, `fqdn`, `request_ip` (the caller's address, refreshed on each poll), `requested_at`, `updated_at` (the heartbeat: stamped every time the waiting host re-polls), `status`, `expires_at` (`requested_at` + 5 minutes, when the server auto-denies it), and `live` (`true` once the host polled again after asking — someone is parked on the approval box; one-shot headless calls stay `false`). Stale requests are retired before listing and every 10 seconds by the insecure worker, each publishing `insecure.denied` with a `reason`: `timeout` (five minutes unanswered; status `denied`, starts the 60-second deny cooldown), `abandoned` (no poll for 30 seconds; status `expired`, no cooldown), or `superseded` (host deleted, made secure, or already inside an open window; status `expired`). A polling host whose pending request was abandoned gets a fresh request instead of a cooldown, and the first re-poll of a new request publishes `insecure.requested` with `live: true`.
- Admin clients open the approval modal for every new live, unexpired, unresolved pending request ID, via websocket-triggered refetch or polling. Requests with `live: false` remain visible in management mode but do not trigger popups; resolved rows in cached reads are also excluded. After a displayed queue drains, the modal closes in triage and management modes once resolution feedback finishes; an empty manually opened management panel stays open. Failed or in-flight queue reads do not close the modal.
- `POST /admin/insecure-approvals/{id}/allow-domain` — approve a pending insecure-host request and add or update a domain auto-allow rule (auto-opens matching subdomains while the rule is active). Body: optional `domain` (defaults to the host's parent domain and must be a proper suffix of the host FQDN, else `422`), optional `duration_minutes` (`0..480`, default 480 — the host's stored window is not consulted), optional `permanent` (stores `enabled_until: null`, a rule that never lapses; `window_minutes` still sets how long each matched host's own window stays open, and `disable-all` still clears it). Pending requests older than five minutes are auto-denied before approval. Because the gate admits every host under the domain from that moment, every other pending request the rule covers is approved and its window opened in the same call, using the same suffix rule the gate uses; the response returns `cleared_request_ids` alongside `request`, `host`, and `domain`.
- `POST /admin/insecure-approvals/{id}/approve` — approve a pending insecure-host request and open the host window. Pending requests older than five minutes are auto-denied before approval. Optional body `duration_minutes` (`0..480`); when omitted the grant is 480 minutes rather than the host's stored sliding window, and whichever length is granted is written back as the host's `insecure_window_minutes` so the next request does not collapse it to ten.
- `POST /admin/insecure-approvals/{id}/deny` — deny a pending insecure-host request (client remains blocked).
- `POST /admin/insecure-domain-allows/{id}/revoke` — revoke a domain auto-allow rule (future subdomain connections will require approval again).
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips`.
- `POST /admin/hosts/{id}/release-ip-binding` — clear the stored `ip4` and `ip6` bindings for a controlled network move while retaining the host's secure and roaming settings. The next valid host-authenticated request establishes the replacement binding. The release records the prior addresses in the admin audit trail. On a secure, non-roaming host the first request after release binds only its own family; the other family is then refused until roaming (or an insecure window) lets it bind. A host-key request refused by the binding gets `401 ip_mismatch` with `ip_family` (`ipv4`|`ipv6`) naming the refused request's own family; the body never names the bound addresses.
- `POST /admin/hosts/{id}/reverse-dns` — set per-host reverse DNS enforcement (`mode`: `global` | `enabled` | `disabled`).
- `POST /admin/hosts/{id}/curl-insecure` — toggle TLS verification bypass for host sync (`allow` boolean). Future signed wrapper configs carry `allow_insecure: true`.
- `POST /admin/hosts/{id}/model` — set per-host model overrides. Body: `{model_override: string|null, reasoning_effort_override: string|null, claude_model_override: string|null, grok_model_override?: string|null, grok_reasoning_effort_override?: string|null}`. Null/empty values mean “Standard (global)”; Codex changes apply to the baked per-host `cdx` wrapper, Claude changes to the baked per-host `clx` wrapper, and Grok changes to the baked per-host `cgx` wrapper. `model_override` is strict-allowlisted to `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. GPT-6.1 Sol (default effort `low`), Astra, both older Sols and Terra accept `low|medium|high|xhigh|max|ultra`; both Lunas stop at `max`. GPT-5.5 is deprecated and no longer offered; stored selections migrate to `gpt-6.1-sol`, preserving a valid effort (otherwise `low`). The fleet default is `gpt-6-astra` with `medium` reasoning. Stored retired Codex ids are backfilled to Astra with the intentionally retained `high` migration effort; the exception is `gpt-5.4-mini` (retired upstream 2026-08-31), which backfills to `gpt-5.6-luna` per its catalog `upgrade` block.
- `POST /admin/hosts/{id}/codex-version` — set per-host Codex CLI version override. Body: `{selection: "global"|"<x.y.z>"}` (or `client_version_override` as a string/null). `global` clears the override and uses the fleet policy; explicit versions below the internal minimum `0.125.0` are coerced upward to `0.125.0`. A host override is served to that host as `client_version_override` with `client_version_enforce_exact=true`, so the wrapper matches it exactly rather than treating it as a floor.
- `POST /admin/hosts/{id}/claude-version` — set per-host Claude Code CLI version override. Body: `{selection: "global"|"<x.y.z>"}` (or `claude_client_version_override` as a string/null). `global` clears the override and uses the fleet Claude policy. Explicit versions must be semantic (`x.y.z`); responses include the normalized override and effective version. As with the Codex equivalent, a host override is served to that host as `client_version_override` with `client_version_enforce_exact=true`.
- `POST /admin/hosts/{id}/agents-version` — set per-host AGENTS.md version override. Body: `{selection: "global"|<version_id>}` (or `agents_document_id_override` as a numeric/null). `global` clears the override and uses the fleet setting; selecting a version pins this host to a specific AGENTS.md revision.
- `POST /admin/hosts/{id}/clear` — clears canonical auth state for the host across all three engines. It resets `last_refresh`/`auth_digest`, `claude_last_refresh`/`claude_auth_digest`, and `grok_last_refresh`/`grok_auth_digest`, deletes all `host_auth_states` rows for that host, and prunes all recent `host_auth_digests` rows for that host regardless of engine.
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — validate/store canonical `auth.json` (system or host-scoped). A configured, reachable runner and positive live verdict are mandatory.
- `POST /admin/auth/seed-command` — mint a one-time seed command (`curl -fsSL ... | bash`) that uploads local canonical credentials to the server. Body accepts `{engine: "codex"|"claude"|"grok"}` and defaults to `codex`; Codex scripts read `~/.codex/auth.json`, while Claude scripts read `~/.claude/.credentials.json` including current Claude Code OAuth credentials. Grok scripts never read a live `~/.grok/auth.json`: they run a dedicated `grok login --device-auth` in a throwaway `GROK_HOME` and erase it after upload, because xAI rotates refresh tokens and a login must have exactly one refresher; `GROK_SEED_AUTH_PATH` explicitly opts into uploading an existing file nothing else will use. The script normalizes plain credential files by adding `last_refresh` when missing and prints server validation errors on upload failure. Returns `command`, `engine`, and `expires_at`. Tokens expire after `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900s). The server atomically reserves a token for one store attempt and releases it after ordinary validation/runner/store failure so the same recovery token can retry. An unsafe runner refresh/readback failure keeps the token consumed because the submitted refresh token may already be spent or its replacement may already be stored pending.
- `GET /seed/auth/{uuid}` — returns an engine-specific shell script that checks the token’s credential path (`~/.codex/auth.json` for Codex, `~/.claude/.credentials.json` for Claude; Grok runs the dedicated device login described above) and posts it to `/seed/auth/{uuid}`. Intended for `curl -fsSL ... | bash`.
- `POST /seed/auth/{uuid}` — accepts a raw credential payload (or `{ "auth": ... }`), validates it for the token’s engine, stores canonical auth, and consumes the seed token after a successful store. A configured, reachable runner and positive live verdict are mandatory.
- `GET /seed/v2/auth/{uuid}` / `POST /seed/v2/auth/{uuid}` — aliases of the `/seed/auth/{uuid}` pair above; seed commands minted against the v2 URL keep working unchanged.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set persisted `api_disabled` flag (when true, all API routes return 503; `/admin/api/state` stays reachable so operators can re-enable).
- `GET /admin/api/surfaces` / `POST /admin/api/surfaces/{surface}` — list exposed APIs with their backend engine, kill switch and active key count; switch a surface's backend and/or kill switch. See [Exposed API routing](#exposed-api-routing-any-to-any).
- `GET /admin/engines/state` / `POST /admin/engines/{engine}/state` — fleet-wide engine master switches: list each engine's on/off state, or switch one with `{enabled}`. See [Engine master switches](#engine-master-switches).
- `GET /admin/engines/{engine}/destroy`, `POST /admin/engines/{engine}/destroy`, `DELETE /admin/engines/{engine}/destroy`, `POST /admin/engines/{engine}/destroy/purge`, `POST /host/engine-destroy/report` — fleet-wide destroy engine. See [Engine destroy](#engine-destroy).
- `GET /admin/openai/state` / `POST /admin/openai/state` — read/set persisted `openai_api_disabled` flag (toggles OpenAI-compatible API independently). `settings.read` / `settings.manage`.
- `GET /admin/openai/keys` — list all OpenAI API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.
- `POST /admin/openai/keys` — create a new OpenAI API key. Body: `{name: string, expires_at?: string, backend_engine?: "codex"|"claude"|"grok"}`. Returns the full key (shown once) and the record. Keys use the `sk-cdx-` prefix.
- `POST /admin/openai/keys/{id}/toggle` — enable or disable an OpenAI API key. Body: `{active: bool}`.
- `DELETE /admin/openai/keys/{id}` — delete an OpenAI API key.
- `GET /admin/claude/state` / `POST /admin/claude/state` — read/set persisted `claude_api_disabled` flag (toggles Anthropic-compatible API independently). `settings.read` / `settings.manage`. See [Admin: Claude management](#admin-claude-management) for full details.
- `GET /admin/model-defaults/{engine}` — read the fleet CLI model defaults for `codex`, `claude`, or `grok`. Returns `{status:"ok", engine, model, reasoning_effort, catalog:[{model, persistent_efforts, default_effort}]}`; the catalog is the authoritative model-dependent selector contract. GET is read-only: if no engine config row exists it reports the effective catalog default (Codex Astra/medium, Claude Sonnet 5/high, or Grok `grok-4.7`/high) without creating a row. Codex model defaults are Astra/GPT-6 Sol/GPT-6 Luna/Terra/GPT-5.6 Luna `medium` and GPT-6.1 Sol/GPT-5.6 Sol `low` (the retired Spark model is no longer in the catalog); its accepted effort sets match the per-host contract above. Grok's catalog is `grok-4.7`, `grok-4.7-build-fast`, and `grok-4.6` (`low`/`medium`/`high`/`xhigh`) plus `grok-4.5` (`low`/`medium`/`high`), all defaulting to `high`.
- For Grok only, the model-defaults response also includes `context_window` and each catalog entry adds `context_windows: [256000, 500000]` and `default_context_window: 256000`. POST additionally accepts `context_window?: number|null`: omission preserves the saved window (256000 on a new config), `null` resets to the catalog default, and other values return HTTP 422. The canonical structured setting renders as `[model."<effective-model>"].context_window` in native Grok TOML, including when a host overrides the model. Model/effort-only callers remain compatible; Codex and Claude reject this field. The selected window is included in the `admin.model_defaults` audit event.
- `POST /admin/model-defaults/{engine}` — set the fleet CLI defaults. Strict body: `{model: string, reasoning_effort?: string|null}`. Omitted/null effort selects the model's `default_effort`; unsupported engines, models, efforts, or extra fields return HTTP 422 `validation_failed`. Codex persists `model` / `model_reasoning_effort`; Claude stores the abstract fleet `model` / `effortLevel` and renders native `modelSettings[canonicalModel].effortLevel`; older models also receive the compatible top-level key. Claude persistent capabilities are Fable 5/5.1, Opus 5, Opus 4.8, and Sonnet 5 `low|medium|high|xhigh` (default `high`); Opus/Sonnet/Haiku 5.5 have the same set with default `medium`; Opus 4.7 defaults to `xhigh`; Opus/Sonnet 4.6 support `low|medium|high` (default `high`); Opus 4.5 and Haiku 4.5 have no native effort value (`null`, so managed effort keys are removed). This follows the native CLI settings schemas: Codex effort is model-dependent, while Claude Code persists only `low|medium|high|xhigh`; its `max` effort is session-only and is intentionally not offered here.
- `GET /admin/claude/keys` — list all Claude API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.
- `POST /admin/claude/keys` — create a new Claude API key. Body: `{name: string, expires_at?: string, backend_engine?: "codex"|"claude"|"grok"}`. Returns the full key (shown once) and the record. Keys use the `sk-ant-` prefix.
- `POST /admin/claude/keys/{id}/toggle` — enable or disable a Claude API key. Body: `{active: bool}`.
- `DELETE /admin/claude/keys/{id}` — delete a Claude API key.
- `GET /admin/claude/version` — Claude Code fleet version summary (the same shape the Codex version card uses).
- `POST /admin/claude/version` — set the fleet Claude Code version policy. Body `{selection: "latest"|"auto"|"<x.y.z>"}`; `latest`/`auto` clear the lock and refresh from upstream.
- `GET /admin/claude/config` — Claude `settings.json` builder state: the stored sub-blocks plus the baked document and canonical `revision` (string, or `null` when missing).
- `POST /admin/claude/config/render` — render `{settings}` into the baked `settings.json` without storing it.
- `POST /admin/claude/config/store` — store `{settings, expected_revision?: string|null}` as the served Claude config. The shared atomic revision contract below applies; optional `sha256` remains a legacy rendered-content check.
- Claude artifacts, where `{kind}` is `subagent`, `command`, or `output-style` (plural/alias spellings accepted); hosts read the same set through `/claude/{kind}`:
  - `GET /admin/claude/{kind}` — list artifacts of that kind, soft-deleted entries included.
  - `GET /admin/claude/{kind}/{slug}` — one artifact with its frontmatter and body; unknown slugs return `404 artifact_not_found`.
  - `POST /admin/claude/{kind}/store` — create/update an artifact; the kind's required frontmatter keys (`name`/`description` for subagents, `description` for commands) are enforced.
  - `DELETE /admin/claude/{kind}/{slug}` — soft-delete an artifact so hosts retrieve `status:deleted`.
- `GET /admin/claude/settings` / `POST /admin/claude/settings` — read/set the separate Anthropic-compatible API proxy defaults (`default_model`, `max_tokens`). These values do not change the Claude Code fleet `model` / `effortLevel` managed by `/admin/model-defaults/claude`. Gated as authored content (`content.read` / `content.manage`), not as a fleet setting. Supported models: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`.
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set ChatGPT quota policy (`hard_fail` boolean), the warn/kill threshold (`limit_percent`, integer 50–100), and optional weekly partitioning (`week_partition`: `0|off`, `7`, or `5`). When `false`, `cdx` warns once usage meets the configured limit but still launches Codex; when `true`, exceeding the limit blocks execution. A non-zero `week_partition` adds a daily allowance bar in `cdx` (derived from the weekly window) that obeys the same warn/deny policy.
- `GET /admin/cdx-silent` / `POST /admin/cdx-silent` — read/set fleet-wide wrapper quiet mode (`silent` boolean). When enabled, `cdx` suppresses boot info/warn logs and only emits errors.
- `GET /admin/model-tier-check` / `POST /admin/model-tier-check` — read/set the default-on Model Class Check (`enabled` boolean). When enabled, served AGENTS.md/CLAUDE.md/Grok AGENTS.md end with a `model_tiers` section: configured model and tier, the tier table of the host's active engines, and model tier guidance (one-tier gap warns; two or more stops before scouting/planning unless explicitly overridden after acknowledging the mismatch; whole-stack assessment is Tier 4) (logged as `admin.model_tier_check`).
- `GET /admin/api-keys-in-chat` / `POST /admin/api-keys-in-chat` — read/set the default-off cross-engine chat-key policy (`enabled` boolean). When enabled, served AGENTS.md/CLAUDE.md tells agents to accept operator-supplied API keys without generic security lectures while avoiding unnecessary echoing, persistence, or use outside the requested task.
- `GET /admin/agents-generation-mode` / `POST /admin/agents-generation-mode` — read/set the fleet-wide master switch for how the canonical middle of AGENTS.md/CLAUDE.md is produced. Body/response `mode` is one of `managed` (default: the composed policy modules plus custom instructions), `manual` (the stored document verbatim), or `off` (the generated modules are dropped and only the operator's custom instructions remain). Unknown values are rejected with `422 validation_failed`; an unrecognized *stored* value reads back as `managed`, so a settings row this build cannot parse never strips prose fleet-wide. The switch is applied when a document is rendered, not when it is stored — `POST /admin/agents/store` keeps writing the full module selection at every mode, so flipping back restores it without a new version. No position suppresses the mandatory policy block or the managed feature block. Also reported as `generation_mode` on `GET /admin/agents`.
- `GET /admin/reverse-dns` / `POST /admin/reverse-dns` — read/set fleet-wide reverse DNS enforcement (`enabled` boolean). When enabled (or per-host override enabled), `/auth` requires a forward A/AAAA match and reverse PTR match for the calling IP.
- `GET /admin/response-verbosity` / `POST /admin/response-verbosity` — read/set the fleet-wide response-verbosity dial. Body/response `level` is `0..4` (`0` default, a true no-op: byte-identical to the level being unset). Non-zero levels replace the served `## Default Response Shape` policy text with progressively terser wording (see `api/src/services/agent-response-style.ts`) and, for `clx` hosts, set `outputStyle` in the rendered `settings.json` partial to a matching `verbosity-*` Claude output style — level 0 omits `outputStyle` entirely so a host/user's manually chosen style is left alone. The four `verbosity-*` documents themselves are ordinary `output-style` artifacts (kind `output-style`), seeded once by migration and editable like any other via `GET /admin/claude/{kind}` / `GET /admin/claude/{kind}/{slug}`.
- `GET /admin/theme` / `POST /admin/theme` — read/set the stored admin UI theme (`auto` default). The Svelte console renders `auto`/`light`/`dark` as neutral system/light/dark modes; historical `auto-pink`, `bright-pink`, and `dark-pink` values remain accepted for compatibility and are normalized client-side. The selected value also rides along in the `/auth` `versions` block as `admin_theme`.
- `GET /admin/auto-update` / `POST /admin/auto-update` — read/set the fleet auto-update flag (`enabled` boolean). Per-host `/admin/hosts/{id}/auto-update` overrides win over it.
- `GET /admin/authorization` / `POST /admin/authorization` — read/set how the capability matrix is enforced. Body `{mode: "compatible"|"strict"}`. The GET returns `{mode, updated_at, would_deny}`, where `would_deny` lists the distinct `{role, capability, route, first_seen, last_seen}` triples this installation served under `compatible` that `strict` would refuse — the answer to "what breaks if I switch", drawn from the fleet's own traffic over the last 30 days. Requires `security.manage_authorization`, which is enforced under **both** modes: `compatible` grants `settings.manage` to every role, so a posture any account could change would not be one. Migration `0022` sets `compatible` on installations that already had users and `strict` on fresh ones; see [ADMIN.md](ADMIN.md#roles--capabilities).
- `GET /admin/log-retention` / `POST /admin/log-retention` — retired compatibility endpoint: always returns `{enabled:false,supported:false,reason:"use_server_retention_api",replacement:"/admin/server-retention"}`. Old durations are ignored and no setting is persisted.
- `GET /admin/scaling` / `POST /admin/scaling` — read the scaling status and store the scaling rules; invalid rules return `422 validation_failed` with per-rule errors. Hosts flagged `scaling_exempt` through `/admin/hosts/{id}/scaling-exempt` are excluded.
- `POST /admin/prune-policy` — set host inactivity pruning window. Body `{inactivity_days: 0..60}`.
- `POST /admin/codex-version` — set the fleet Codex CLI version policy. Body: `{selection: "latest"|"<x.y.z>"}`. `latest` keeps the GitHub-latest flow; explicit versions below the internal minimum `0.125.0` are coerced upward to `0.125.0`. Exact downgrade behavior only applies when `client_version_enforce_exact=true` (that is, the fleet pin is above the floor).
- `GET /admin/logs?limit=` — recent audit events.
- `GET /admin/runner` — runner config/telemetry (configured flag, runner URL, readiness detail, combined state, and engine-scoped telemetry at `runner.engines.codex` / `runner.engines.claude` / `runner.engines.grok` with `state`, `last_check`, `last_ok`, `last_fail`, `last_run`, and `last_error`). Persisted telemetry is projected as `idle` with cleared timestamps for an engine that has no currently verified, structurally valid, distributable canonical auth; stale rows from a reused database therefore cannot render a false healthy badge. `POST /admin/runner/run` verifies the latest Codex canonical auth payload; `POST /admin/runner/run-claude` does the same for Claude via the runner's `/verify-claude` path, where native Claude Code OAuth payloads are verified by a real Claude CLI probe rather than by sending the OAuth access token as a public API key. Both take **no request body fields** — a body carrying the retired `prompt` / `model` / `reasoning_effort` / `preview` / `timeout_seconds` keys returns `422 validation_failed`. Both go through the canonical auth store's `ensureServedVerification` (forced live, TTL 0), so refreshed credentials are promoted under compare-and-swap or quarantined exactly as on the `/auth` store path. The response carries `engine`, `verdict` (`verified` / `failed` / `unknown`), `applied`, `probed`, `canonical_digest_before`, `canonical_digest`, `canonical_last_refresh`, `payload_id`, `detail`, and, only when a probe actually ran, `reachable` and `latency_ms`; credential bytes are never returned.
  Each engine also exposes optional `login_expiry: { state, expires_at, days_remaining }`, including when the runner is unconfigured. States are `unknown`, `ok`, `expiring`, `expired`, and `not_applicable`; timestamps are ISO UTC or null, and remaining days are rounded upward (zero after expiry, null when unknown). Claude OAuth uses the selected canonical payload's `claudeAiOauth.refreshTokenExpiresAt`: warn at <=72 hours, expired at <=0; access expiry > refresh expiry +72 hours suppresses the warning (`not_applicable`), matching Claude Code 2.1.263. Missing/malformed timestamps are `unknown`; Codex and API keys are `not_applicable`. This read-only assessment is independent of verification, includes no credentials, makes no provider calls, and never changes admission or launch policy.

- `POST /admin/versions/check` — refresh GitHub client release cache.
- `GET /admin/chatgpt/usage[?force=1]` — account-level ChatGPT `/wham/usage` snapshot using canonical `auth.json` token (5-minute cooldown unless `force`). Provider Unix-second `reset_at` numbers are normalized to ISO timestamps before storage, alongside existing ISO-string compatibility; the same stored values feed MCP `quota_get`'s `resets_at`. Rows missing resets gain them on their next successful refresh. The default Compose `quota-cron` worker refreshes this stored snapshot at boot and then every `CHATGPT_USAGE_CRON_INTERVAL` seconds (default 900); host `/auth` retrieval only reads the stored result.
- `GET /admin/chatgpt/usage/history?days=60` — quota history for dashboard graphs (normal/spark lane, primary + secondary windows), capped to the past 180 days. History is served from the set-aside graph snapshot store so the charts survive verbose log cleanup. Query params: `days` (1..180), optional `from`/`until` (RFC3339/date strings), optional `interval=raw|hour|day`, optional `lane=normal|spark|both`, optional `window=primary|secondary|both`. Returns compatibility `points` and normalized `series` plus `days`, `since`, `from`, `until`, `interval`, `lane`, `window`. Each series carries `lane`, `window` and `limit_seconds` — the window length that slot currently measures, taken from the newest point reporting one. A slot does not always mean the same window: chatgpt.com moved the normal lane's weekly quota from `secondary_window` into `primary_window` on 2026-07-11, so a series admits only the points measured against its current `limit_seconds` and readings from the older window are left out rather than charted as one continuous line.
- `GET /admin/claude/usage` — latest Claude subscription quota snapshot. Read-only: unlike ChatGPT usage this is never fetched by the server (Anthropic's Consumer ToS prohibits third-party use of a Free/Pro/Max subscription's OAuth token), so there is no `force`/refresh param — rows arrive only via `POST /claude/usage/report` from the clx wrapper's fleet-owned statusLine command. Returns `{snapshot}`, `null` when nothing has been reported yet.
- `GET /admin/claude/usage/history?days=60` — Claude quota history for dashboard graphs (5-hour + weekly windows). Query params: `days` (1..365), optional `from`/`until`. Returns `{days, from, until, series}` with `series` keyed `five_hour`/`seven_day`.
- `POST /admin/chatgpt/usage/refresh` — force-refresh ChatGPT usage snapshot (bypasses cooldown).
- `GET /admin/agents` — fetch AGENTS.md serving state for the dashboard. Returns canonical AGENTS state: `status`, `mode` (`latest` | `locked`), `active_id`, `served_id`, `latest_id`, `backup_limit` (`null` = unlimited historical backups), served base-document `sha256` + `updated_at` + `size_bytes` + `content`, and `versions` (id/sha/created/updated/size + flags). `locked` means the fleet is pinned to a specific historical version; `latest` means serving follows the newest stored edition. This endpoint never expands host-specific features; host-facing `/agents/retrieve` appends the single managed-feature block described above. Browser GET/HEAD navigation preferring `text/html` receives the static SPA shell before the session gate; JSON requests keep the existing session requirement and response contract.
- `POST /admin/agents/compose` — normalize a toggle-builder composition and render its canonical base document without storing it. The three fleet identity, safety-floor, and hard-stop sections are mandatory; optional operating modules and custom Markdown are returned with the normalized composition and digest. Also returns `provenance`: the module and custom-instruction blocks in document order, each with the `##` headings its own Markdown contains. Composing knows nothing of a host or a posture, so it describes no policy or feature blocks — those come from `POST /admin/agents/render`.
- `POST /admin/agents/render` — render an unsaved raw or composed draft through the exact host- and engine-specific managed renderer. Body: `{ host_id, engine?, content?, composition?, security_levels? }`. This is the preview counterpart to host retrieval and has no sync side effects. Two preview-only fields accompany the document, and are deliberately absent from the serve path: `provenance`, every highlightable block in document order (`policy:*`, `module:*`, `custom_instructions`, `feature:*`, or a single `legacy_document` for an un-composed body), and `axis_sections`, which names the policy sections each security axis currently contributes text to. Attribution is section-level: one axis routinely reaches two sections at once, and a single Hard Stop bullet can be the joint work of several, so neither field claims sole ownership of any sentence.
- `GET /admin/agents/render?host_id={id}&engine=codex|claude|grok` — read-only preview of the exact current document the selected host would receive. Requires an enrolled host with the requested engine; defaults `engine` to `codex`. Returns the host identity, effective document metadata/content, base and managed digests, and managed-feature `sections`. It uses the same server renderer as `/agents/retrieve`, but does not record a host sync or issue a wrapper-side effect.
- `GET /admin/agents/versions/{id}` — fetch one historical AGENTS.md version with full `content`, `sha256`, timestamps, `size_bytes`, and `is_latest` / `is_active` / `is_served` flags for read-only admin inspection.
- `POST /admin/agents/store` — create a new AGENTS.md edition. Body: `content` (string markdown), optional `sha256` check (64-hex). Returns `status` (`created` | `updated` | `unchanged`), `version_id`, `sha256`, `updated_at`, `size_bytes`, and optional `pruned_count` when retention cleanup deleted older unprotected backups. Overlapping identical saves are deduped against the current latest version under a DB lock, so the endpoint returns `unchanged` instead of spraying duplicate history rows.
- `POST /admin/agents/retention` — set AGENTS historical backup retention. Body: `{ backup_limit: 0..200|null }`; `0`/`null` disables pruning and restores unlimited history. Response returns `backup_limit` (`null` when unlimited) plus `pruned_count`. Retention counts only historical backups: the newest latest draft is always kept, and the currently served fleet version plus any host-pinned versions are protected from automatic deletion even if that temporarily exceeds the configured cap.
- `GET /admin/agent-policy-profiles` — list named fleet security postures with their assigned host ids, plus the axis/preset `catalog` the console renders sliders from.
- `POST /admin/agent-policy-profiles` — create a profile. Body: `{ name, description?, levels? }`; `levels` is normalized against the axis registry, so unknown axes are dropped and missing ones fall back to the fleet default vector.
- `POST /admin/agent-policy-profiles/:id` — update a profile's `name`, `description`, or `levels`. Bumps the profile's own `revision`; the agents document's version history is unaffected, because prose and posture are versioned separately.
- `DELETE /admin/agent-policy-profiles/:id` — delete a profile and every host assignment pointing at it. Rejects the fleet default, which is the fallback every unassigned host resolves to.
- `POST /admin/agent-policy-profiles/:id/default` — make this profile the fleet default, clearing the flag from whichever profile held it.
- `POST /admin/agent-policy-profiles/assign` — assign a host to a profile. Body: `{ host_id, profile_id }`; `profile_id: null` clears the assignment back to the fleet default. Orthogonal to `agents_document_id_override`, which pins which prose document a host receives.
- `GET /admin/agent-policy-profiles/enforcement?host_id=` — read-only projection of a host's resolved posture onto engine config (`approval_policy`, `sandbox_mode`, `sandbox_workspace_write.network_access`, `web_search`, `features.guardian_approval`, Claude `permissions.defaultMode`), each naming the axis currently governing it, plus the keys deliberately not enforced and why. Also returns `permission_clamps`: non-empty when the host cannot be served the Claude permission mode its posture asks for, which today means a root agent user and `bypassPermissions` (Claude Code refuses to start in that combination, so `auto` is served instead). `GET /admin/agent-policy-profiles` correspondingly returns `root_hosts`, the fqdns whose agent user is root, and gives each profile a derived `claude_permission_mode` so the console never re-implements the level-to-mode rule.
- `POST /admin/agents/serve` — set the serving mode. Body: `{ mode: "latest" | "locked", version_id?: number }`. `mode=latest` follows newest editions; `mode=locked` pins the served version to `version_id`, which must belong to the requested engine. Old cross-engine locks fall back to normal latest selection; the existing latest-any fallback for an engine without a document remains available.
- `POST /admin/agents/revert` — create a new latest AGENTS.md edition by cloning a historical version. Body: `{ version_id: number }`. Revert preserves immutable history, creates a fresh newest row with the selected content, resets serving mode to `latest` so the new latest version is also what the fleet receives, and may return `pruned_count` when retention cleanup deletes older unprotected backups.
- `DELETE /admin/agents/versions/{id}` — delete a non-served AGENTS.md edition by id.
- `GET /admin/config` — fetch saved Codex configuration metadata, historical `content` and normalized `settings`. Returns `status` (`missing` when unset), `revision` (canonical row id as a string, or `null` when missing), `sha256`, `updated_at`, `size_bytes`. Unspecified feature switches retain native defaults, including async compaction (under development and off by default in Codex 0.163.0; no implicit key is rendered for any client version). Engines → Codex provides an immediately saved toggle using the normal preview/store and revision contract; explicit values and profile overrides remain effective. The normalized legacy `personality` field is retained for compatibility but is not emitted into current native TOML.
- `POST /admin/config/render` — validate and render a `settings` payload into TOML without persisting it. Returns `content`, `sha256`, `size_bytes`, normalized `settings` and separate profile previews. Unknown, removed or invalid authored feature values receive HTTP 422 with a field path before normalization can discard them; explicit supported legacy aliases migrate to canonical fields.
- `POST /admin/config/store` — persist validated canonical Codex configuration built from `settings`. Optional `expected_revision` atomically guards the full saved document (see below). Optional `sha256` retains its legacy saved-content check. Returns `status:ok`, `change` (`created` | `updated` | `unchanged`), `revision`, `sha256`, `updated_at`, `size_bytes`, `content`, and normalized `settings`.

All three Engines editors accept engine-specific `settings.native_settings`, with server validation/preview and exact ownership on host sync. Current coverage is Codex 0.163.0, Claude Code 2.1.301 and Grok Build 1.0.60. Codex 0.163-only options conditionally require that native version, including profile-only values; existing extensions retain their 0.162.1 floor. Claude's extension floor remains 2.1.296, including `idleCompaction` (introduced earlier). Update/report routes remain usable before a gated sync. See [configuration scopes](NATIVE_CONFIG_SCOPES.md) and the engine interfaces for precise types and native policy boundaries. Migrations 0071/0072 repair confirmed obsolete or invalid saved settings; saved `content`/`sha256` remain historical snapshots until the next normal save, while host configurations and previews render the repaired settings.

All three engine config GET/store routes share the revision contract: `revision` identifies the latest immutable `client_config_documents` row, independently of the rendered-content `sha256`. Send `expected_revision` with the value read by the editor; explicit `null` requires that no config exists. An omitted guard preserves legacy callers. A mismatch returns HTTP 409 `config_revision_conflict` with `expected_revision` and `current_revision`; reload and review before retrying. Invalid revision values return 422. Settings-only edits allocate a new revision even when `sha256` stays the same; unchanged saves retain the revision. The engine-specific range lock covers read, comparison and insertion, including an empty head; model-default updates use the same lock for their full read/merge/write operation. `settings.changed` is published only after a successful commit.

- Unified Memory Atlas uses three scopes: `host` for per-host scratch,
  `project` for workstream facts, and `shared` for fleet-wide documents. All
  authenticated admin roles can read these endpoints. Mutations require an
  authenticated `owner` or legacy `admin` account.
- `GET /admin/memories/graph` — full-body-free graph/list feed. Query accepts
  comma-separated `scopes` (`host,project,shared`), `q`, comma-separated `tags`,
  `host_id`, `project_slug`, `engine`, `limit`, and opaque `cursor`. Returns
  `{nodes, edges, facets, facets_truncated, totals, count, next_cursor,
  truncated}`. Pages default
  to 500 records and clamp `limit` to 2,000; cursors are bound to the filter set
  that produced them and are rejected when reused with different filters.
  Host, project, and tag facet arrays expose their top 200 values by count;
  `facets_truncated` flags each capped dimension. Scope and engine facets are
  inherently bounded.
  Memory nodes use canonical `node_id` values (`memory:{scope}:{record_id}`),
  expose the immutable key/slug separately from numeric `record_id`, and never
  include full content or metadata. Relationships are explicit only:
  `in_scope`, `owned_by`, `in_project`, `tagged_with`, `written_by`, and
  `from_engine`; there are no inferred content-similarity edges.
- `GET /admin/memories/{scope}/{recordId}` — fetch one normalized memory with
  body, metadata, tags, scope ownership/provenance, timestamps, capabilities,
  and a full-state hex `etag`. The same value is sent as a quoted HTTP `ETag`
  header. A missing row returns 404 `memory_not_found`.
- `POST /admin/memories/{scope}` — create one memory. Every scope requires
  `id` (immutable key/slug) and `content`; `key` is accepted as an identity
  alias, as is `slug` for shared documents. Host scope additionally requires
  `host_id` and accepts `metadata`, `tags`, `summary`, and `engine`; project
  scope requires `project_slug` and accepts `metadata` and `tags`; shared scope
  accepts `title`, `summary`, `metadata`, `tags`, and `engine`. Duplicate
  identities return `409 memory_conflict`; validation failures return 422.
  Success returns 201 `{status:"created", memory}` plus the new HTTP `ETag`.
- `PATCH /admin/memories/{scope}/{recordId}` — update mutable body/metadata
  fields. Supply `expected_etag` in the body or an `If-Match` header; the
  key/slug and host/project ownership are immutable. The write locks and
  re-checks current state, then returns `{status:"updated"|"unchanged", memory}`
  plus its HTTP `ETag`. A stale ETag returns `409 memory_conflict` with
  `current_etag` and `node_id` and leaves the stored row unchanged.
- `DELETE /admin/memories/{scope}/{recordId}` — permanent delete. Body must
  supply `expected_etag` (the query string and `If-Match` header are accepted
  alternatives); a stale value returns `409 memory_conflict`. Success returns
  `{status:"deleted", node_id, scope, record_id}`. Every admin-scope delete is
  hard, including host and project memories. A delete has no trash or undo;
  a shared document's replaced body can be restored (below) while it exists.
- `POST /admin/memories/shared/{recordId}/append` — append to a shared document
  through the same row-lock/chunk/revision path as `shared_memory_append`, so
  concurrent additions are serialized rather than lost. The strict body is
  `{content:string}`; other keys fail validation. Returns the updated normalized
  memory with `status:"appended"` and the new HTTP `ETag`.
- `POST /admin/memories/shared/{recordId}/restore` — undo one replace of a shared
  document: `{revision, expected_etag}` (or `If-Match`) writes back the body that
  revision overwrote as a new revision, preserving title, summary and tags. Only the
  newest five replaces keep their earlier body (shared revision audit rows carry
  `restorable`). A stale ETag answers 409 `memory_conflict`; a revision without a
  kept body answers 422. Audited as `admin.memory.restored`.
- `GET /admin/memories/audit` — normalized operational activity for required
  `node_id`; optional `limit` (default 50, maximum 200) and opaque cursor page
  the response. It returns
  `{status:"ok", node_id, activities, next_cursor, truncated, retention}` and
  combines body-free admin logs, project events, and shared revision metadata.
  This feed follows source-log retention, is not immutable compliance history,
  and cannot restore prior bodies.
- Deprecated host-memory compatibility endpoints remain unchanged:
  `GET /admin/mcp/memories` accepts `q`/`query`, `host_id`, `tags`, and `limit`
  (1–200, default 50) and returns body-bearing `matches`; numeric
  `DELETE /admin/mcp/memories/{id}` soft-deletes that row. They do not
  gain the unified ETag, role, or response contract.
- Deprecated shared-memory compatibility endpoints also remain unchanged:
  `GET /admin/shared-memories` accepts `q`/`query`, `tags`, `prefix`, `limit`,
  and `offset`; `GET /admin/shared-memories/{slug}` returns full content plus up
  to 20 revision metadata rows; and `DELETE /admin/shared-memories/{slug}`
  permanently deletes the document, chunks, and revision trail. New clients
  should use `/admin/memories/*`.
- Fleet secrets store — the working credentials agents use once they are running
  (GitHub PATs, database passwords, Bookstack/Checkmk tokens, SSH keys,
  third-party service keys). Distinct from engine-boot auth under `/auth`, which
  has its own runner-verified lifecycle; the two are never merged. Delivery to
  hosts is MCP-only (`secret_list`, `secret_search`, `secret_get`,
  `secret_store`, `secret_delete`) and no value
  is ever written to a host filesystem, so a soft delete takes effect on the
  next read. All four mutations and the reveal require the owner or admin role.
  - `GET /admin/secrets/state` — `{enabled, updated_at, count}` for the
    `secrets_module_enabled` switch.
  - `POST /admin/secrets/state` — `{enabled}` (boolean, `0`/`1`, or
    `"true"`/`"false"`). While the module is off the `secret_*` MCP tools serve
    disabled status/capabilities and the managed AGENTS.md block is not rendered; admin CRUD stays
    live so secrets can be staged before switch-on.
  - `GET /admin/secrets` — metadata listing ordered by slug, `include_deleted=1`
    to include soft-deleted rows. Returns `{secrets:[…]}` and never a value.
  - `GET /admin/secrets/{id}` — one secret's metadata, soft-deleted rows
    included. Never a value.
  - `POST /admin/secrets` — `{slug, name, value, description?, tags?}`,
    responds `201`. All working secrets are shared across Codex, Claude and Grok.
    The removed `engine` scope argument is rejected on create and update. A create
    against a soft-deleted slug revives and rotates that row rather than
    failing, since the unique key is on `slug` alone.
  - `PATCH /admin/secrets/{id}` — `{name?, value?, description?, tags?}`.
    `slug` is rejected: it is the lookup key agents hold, so a rename would
    silently break them. Responds `{secret, rotated}`, where `rotated` is true
    only when the value genuinely differs from the stored one.
  - `DELETE /admin/secrets/{id}` — soft delete; the slug stays reserved and can
    be revived by a later create.
  - `POST /admin/secrets/{id}/reveal` — the only endpoint returning a plaintext
    value, as `{secret, value}`. A `POST` deliberately: a `GET` can be
    prefetched by a browser, cached by an intermediary, and replayed out of
    history. Records a non-broadcast `secret.revealed` admin event.
- **Project board** — cards as the unit of coordinated work on a project, with
  claim/lease semantics mirroring the Git Director. A card carries a role, a
  holder and an expiry; a claim is reclaimed when its holder's agent session
  ends, or when it goes unrenewed past its TTL. Delivery to hosts is MCP-only
  (`project_board_list`, `project_card_create`, `project_card_claim`,
  `project_card_move`, `project_card_release`, `project_card_update`,
  `project_card_get`). Advisory throughout: a role that does not match a lane
  and an exceeded WIP limit both attach an advisory to a move that still
  happens, and the only refusal is recording a claim somebody else holds. Reads
  need `projects.read`, mutations `projects.manage`. Release notes retain their full
  text in the project event log; row summaries are bounded to 255 characters
  (`claim_release_reason`) and 500 characters (`blocked_reason`).
  - `GET /admin/project-board/state` — `{enabled, boards, cards, claimed,
    updated_at}` for the `project_board_enabled` switch. It lives outside
    `/admin/projects/…` because that tree routes `/admin/projects/{slug}` and a
    project named `board` would shadow it.
  - `POST /admin/project-board/state` — `{enabled}` (boolean, `0`/`1`, or
    `"true"`/`"false"`). While the module is off, `project_board_list` answers
    disabled status/capabilities and the rest of the board tools throw; nothing
    is dropped. `project_todo_*` keeps working either way — since migration 0026
    todos are a view of the same cards, keyed by the card number, which is the
    id the todo already had.
  - `GET /admin/projects/{slug}/board` — the lanes with their WIP limits and
    role gates, the cards in each, the live claims with holder and expiry, and
    the recently reclaimed cards with the reason each carried. Shares its URL
    with the client route, so an `Accept: text/html` request is served the SPA
    shell instead of this JSON.
  - `POST /admin/projects/{slug}/board/cards` — `{title, detail?, column?,
    labels?, priority?}`; without `column` the card lands in the lane flagged
    intake. Attributed to the operator rather than to a host.
  - `POST /admin/projects/{slug}/board/cards/{id}` — `{title?, detail?, labels?,
    priority?, blocked_reason?}` in place. Moves nothing, touches no claim.
  - `POST /admin/projects/{slug}/board/cards/{id}/move` — `{column, note?}`,
    naming the lane by key or title. Never refuses; violations come back in
    `advisories` and are written to the log.
  - `POST /admin/projects/{slug}/board/cards/{id}/release` — `{reason?}` takes a
    claim back on the operator's behalf. The board reclaims on its own in two
    cases — a bound agent whose session the fleet can see has ended, and a claim
    that goes unrenewed past its TTL — so this covers only the third: a holder
    that is unreachable but not detectably dead.
  - `DELETE /admin/projects/{slug}/board/cards/{id}` — archives the card rather
    than deleting it, so its `coord_project_events` history keeps a row to point
    at.
  - `POST /admin/projects/{slug}/board/columns/{id}` — `{title?, wip_limit?,
    allowed_roles?, position?, default_next_column_id?}`. There is deliberately
    no create or delete: 0026 seeds the seven lanes, and deleting one would have
    to answer what becomes of the cards in it.
- **Git Director** — a registry of which agent is working in which git clone,
  plus an advisory arbiter over merges into shared branches. The arbitration
  unit is the clone on a host (`git rev-parse --git-common-dir`), so every
  linked worktree of one checkout contends as one; clones sharing a normalized
  remote are grouped across hosts for visibility but never arbitrated together.
  Git operations use MCP (`git_register`, `git_list`, `git_join`,
  `git_merge_request`, `git_merge_status`, `git_release`). Optional server-originated
  `GIT-DIRECTOR/1` notices use the existing Agent Messaging queue. The orchestrator has
  no filesystem access to any host, so every git fact is reported by the calling
  agent and the verdict is advice it can ignore — nothing is enforced and no
  hooks are installed. The module switch and forcing a verdict require the
  owner, admin, or fleet role.
  Registration takes its engine from MCP dispatch. When `username` is omitted,
  a unique fresh live address matching the host, engine and worktree directory
  supplies it; missing or ambiguous matches remain unbound. The address must also
  match the worktree directory (session `workspace.git_root`/`cwd`), so an agent
  that launched in the original checkout binds a linked worktree only after
  `agent_context_update` moves its scope there. Registration replies carry
  `agent_address_bound` (as in `git_list`) and, when false, a `binding_hint`
  naming that repair. An unbound registration cannot have claims attributed to
  it: when only live active claims block a merge and the worktree has no live
  protocol-1 session, `git_merge_request`/`git_merge_status` still refuse with
  `resource_claim_conflict` but say so (`reason: registration_unbound` or
  `registration_session_unavailable` in the HTTP error extra; MCP tool replies
  carry only the message text, which states it), telling the agent to re-register with
  `username`, `engine` and current `head_sha` and retry the same
  `client_request_id`. Uncertain or expired claims keep the generic
  reserved/uncertain refusal. Live bound sessions
  survive registration TTL, while ended or stale sessions are reclaimed on
  sweep. `git_merge_status` also refreshes an active registration before sweeping;
  an expired merge lease still requires a new request.
  `git_join` preserves declared paths when `paths` is omitted; an explicit
  `paths: []` clears previous write scope for read-only work.
  A merge decision compares the request's `changed_paths` with two sets, using
  segment-aware directory prefixes (a declared `docs` covers `docs/x.md`; a
  declared `doc` does not): the live lease holder's changed plus `git_join`
  paths, and the `git_join` paths of every other active, unexpired registration
  in the clone whose `target_branch` is the requested branch or unset. Only a
  live lease, or overlap with the holder's paths, is contention: it goes to the
  arbiter, or without one to a deterministic `wait`. A live holder always prevents
  another `allow`, even if the arbiter recommends it: leases are exclusive per
  clone and target branch. Decisions and the exact worktree are revalidated under
  the coordination gate after model calls; a newer decision or completed request
  is returned unchanged, preserving its lease expiry. Overlap with a non-holding
  peer's declarations never makes a request wait — a declaration is a plan, not
  a hold on the branch, and waiting on one would only end when that peer
  deregisters (two peers declaring `CHANGELOG.md` would wait on each other
  forever). It is reported instead: `overlap` is the union of both sets, a fresh
  verdict (not a replay) carries `peer_overlap`
  (`[{worktree_id, worktree_path, username, branch, paths}]`), and the reason
  names each peer worktree and its overlapping paths; an otherwise uncontended
  request stays `allow` by `policy`.
  Each listed worktree's `branch` and `head_sha` are the snapshot its agent last
  reported, never a live read; `head_observed_at` (additive, nullable) is when
  that `head_sha` was reported. `git_register` sets both (an omitted `head_sha`
  clears them). A `git_list` call naming a registered `worktree_path` refreshes
  `heartbeat_at` only, unless it also carries optional `head_sha` and/or
  `branch`, which replace the stored values (`head_sha` restamps
  `head_observed_at`). For an unregistered path they are ignored and nothing is
  created. Rows registered before 0073 carry `registered_at` as their
  conservative `head_observed_at`.
  `git_list` returns a compact **summary page** by default so a busy host does
  not overflow a client's tool-result window (one host measured 68k characters).
  Optional arguments: `detail` (`summary` | `full`), `limit` (1-100, default 20
  for `summary`, 100 for `full`) and `offset`. The reply gains `detail`,
  `total`, `offset`, `limit`, `truncated` and `next_offset` (null on the last
  page); clones are ordered by `last_seen_at`, except that the clone owning a
  registered `worktree_path` leads. A summary clone carries `worktree_count`,
  `worktrees` (at most 25: id, path, username, engine, branch, `head_sha`, task
  clipped to 120 characters, `target_branch`, `heartbeat_at`; flagged by
  `worktrees_truncated`), `lease_count`, `leases` (id, worktree, branch,
  verdict, expiry; no reason or overlap) and `stale_count` (capped at 25).
  `detail: "full"` restores the complete entries (declared paths, lease reasons
  and overlap, `stale` rows). `scope: "clone"` defaults to `full`.
  **Agent notifications.** With Messaging enabled, routine registration, scope,
  and module bookkeeping remains available through audit, WebSocket invalidation
  and `git_list`; it does not broadcast to ordinary native sessions. `git_join`
  still returns `peer_overlap`. Scope/branch changes and reported merges notify
  only exactly bound current waiters on affected target branches, including the
  previous branch on a scope change. Merge requests notify overlapping owners and
  the current holder; changed decisions/blockers, releases and expiry preserve
  waiter rechecks. Operator decisions/eviction, binding replacement and invalidated
  registrations notify the exact affected live owner where a saved binding exists.
  Operator decision notices carry `other_leases_revoked: false`. Disabling the
  Director retains registrations and leases. Polling remains authoritative.

  Notices are `presence_notice` messages without an acknowledgement requirement,
  bound to `targetSessionId` and `targetBindingGeneration`. Ownership recipients
  must match the session/generation saved by `git_register`; historical unbound
  registrations must re-register and are never guessed onto a new owner. State
  and queue inserts commit together. Expected duplicate/eligibility failures roll
  back the notice savepoint and leave an observable `git_director.notifications`
  audit record; genuine database failures abort the operation. Dashboard and queue
  invalidations publish after commit. Audit records count queued/skipped notices
  and unbound registrations; queued is not proof of receipt. Each notice carries
  an event UUID, request ID where applicable, observation time and monotone audit
  `revision`; `git_list` and merge responses carry the latest global observation revision
  `coordination_revision` (not an atomic snapshot watermark or lease fence). Delayed notices require a fresh status/snapshot and
  must never reactivate an old grant. Owner invalidations use coordination priority
  with a 900-second TTL; scope/completion information has a 3600-second TTL.

  Correctness remains independent of Messaging: it may be disabled, notices may
  expire or be skipped, and polling remains required. Expiry is still detected
  on reads, with no deadline-delivery guarantee. Rebind, reconnect or reactivation
  requires a fresh `git_list`/`git_merge_status`; no historical notice backlog is
  transferred to a replacement session. Identical retries, unchanged waits,
  heartbeats, ordinary registrations/deregistrations, feature HEAD reports, task
  title edits and commit-format settings produce no separate agent notice.

  `git_release` accepts optional `outcome: merged|aborted|unknown` (default unknown).
  A reported outcome requires `request_id` and matching `worktree_path`; `merged` also requires `target_head_sha` (40–64 lowercase hex characters). It remains
  an **unverified agent report**, labelled `evidence: agent_reported`; a reported
  merge informs relevant repository peers, including related clones. Release
  alone proves neither integration, push nor deployment. The first report is stored even after expiry/withdrawal; identical retries
  are silent, `unknown` may be refined once, and conflicting terminal reports return `git_director_outcome_conflict`.
  `git_merge_status` exposes `reported_outcome`, `reported_target_head_sha` and
  `outcome_reported_at`. A `merged` report requires a request with a grant timestamp/lease expiry; it never reactivates a lease. The path is a caller consistency assertion, not additional authentication: the MCP credential is shared by a host. An explicit report releases only the named request unless deregistering. Registration replies
  expose `superseded_registrations: [{worktree_id, withdrawn_request_ids}]`.

  - `GET /admin/git-director/state` — `{enabled, model, clones, worktrees,
    updated_at}` for the `git_director_enabled` switch.
  - `POST /admin/git-director/state` — `{enabled}` (boolean, `0`/`1`, or
    `"true"`/`"false"`). While the module is off the `git_*` MCP tools serve
    disabled status/capabilities and the managed AGENTS.md block is not
    rendered; registrations already recorded are retained, not dropped.
  - `GET /admin/git-director` — `{clones:[…]}`, each with its live worktrees,
    the current lease and queue per target branch, and the 25 most recent
    verdicts carrying `decided_by` and the reason. Shares its URL with the
    client route, so an `Accept: text/html` request is served the SPA shell
    instead of this JSON.
  - `POST /admin/git-director/requests/{id}/decide` — `{verdict, reason?}` where
    `verdict` is `allow` or `deny`. Writes `decided_by: "operator"`, so a
    human's override is never attributed to the model that would otherwise have
    judged it. Completed requests cannot be revived. An `allow` requires an active
    worktree, the normal resource guard and no other live branch lease; release
    the current holder explicitly first. Overriding an already granted request
    preserves its existing lease expiry, including identical retries.
  - `POST /admin/git-director/worktrees/{id}/release` — evict one registration
    and withdraw every merge request it still had outstanding. The Director
    reclaims on its own in two cases — a bound agent whose session the fleet can
    see has ended, and a registration that goes quiet past its TTL — so this
    covers only the third: a registration that is technically alive but which an
    operator already knows is finished, where waiting out a visible TTL is the
    wrong answer.
- File transfer (`transfers.*`). A fleet-wide, TTL'd pool of arbitrary files, so
  agents can hand each other a build artifact or a tarball rather than only
  text (`transfer_list`, `transfer_put`, `transfer_get`, `transfer_info`,
  `transfer_delete`). `transfer_list` carries a `limits` object while the pool is
  available (`max_file_bytes`, `quota_bytes` with `null` = no cap, `used_bytes`,
  `remaining_bytes`, `max_upload_bytes`, `mcp_chunk_bytes`, `binary_chunk_bytes`,
  `default_ttl_seconds`, `max_ttl_seconds`); `transfer_put` accepts an optional
  `expected_size_bytes` that preflights the file cap and free pool on the first
  call of a chunked upload. Bytes live on the `DATA_ROOT` volume (`transfers/<shard>/<id>`)
  rather than in a column, which is why the download below can stream. Expiry
  is swept at the top of every listing and fetch and, because what it reclaims
  is disk, also by a worker every `TRANSFERS_PURGE_INTERVAL_SECONDS` (default
  300; every twelfth tick also reaps orphaned files older than an hour). Every
  change to the pool publishes `transfers.changed`. Reading the listing takes
  `transfers.read`; the switch, the bounds and deleting take `transfers.manage`;
  the bytes themselves take `transfers.download`, which no role below admin
  holds.
  Binary transfer routes are documented in [file-transfers.md](file-transfers.md):
  `POST /host/transfers`, `GET /host/transfers/:id`,
  `PUT /host/transfers/:id/content?offset=N`,
  `POST /host/transfers/:id/complete`, `GET /host/transfers/:id/content`
  (HTTP Range). All require host auth, engine assignment/master switch and the
  managed transfer feature gates. Binary uploads reserve declared size/hash;
  file/pool limits default to `0` (unlimited), retaining explicit settings.
  Chunk commits and quota reservations serialize under a shared short transaction lock. A retry at
  the last committed `size_bytes` removes an interrupted write's uncommitted
  tail before writing and syncing the replacement bytes; the sealed SHA-256
  therefore covers the same bytes returned by downloads. Supply `offset` on
  retries: competing appends at one explicit offset yield one success and one
  conflict. A missing committed file prefix requires a new transfer.
  - `GET /admin/transfers/state` — `{enabled, updated_at, default_ttl_seconds,
    max_ttl_seconds, max_file_bytes, quota_bytes, used_bytes, live_count}` for
    the `transfers_module_enabled` switch and its bounds.
  - `POST /admin/transfers/state` — `{enabled}` (boolean, `0`/`1`, or
    `"true"`/`"false"`). While the module is off `transfer_list` serves disabled
    status/capabilities, the mutating tools refuse, and the managed AGENTS.md
    block is not rendered; files already held are retained and keep expiring.
  - `POST /admin/transfers/limits` — `{default_ttl_seconds?, max_ttl_seconds?,
    max_file_bytes?, quota_bytes?}`, each optional and merged over the current
    values. An incoherent set is refused rather than stored: a default above the
    max, a max outside the 60s-to-7d band, or a quota below the per-file cap.
  - `GET /admin/transfers` — `{transfers:[…]}`, newest first, each carrying
    size, mime type, sha256, asserted uploader, fetch count and `expires_at`.
    `include_retired=1` adds expired and deleted rows. Shares its URL with the
    client route, so an `Accept: text/html` request is served the SPA shell
    instead of this JSON.
  - `GET /admin/transfers/{id}/events` — `{events:[…]}`, the append-only trail
    for one file with `action`, `actor_kind` and `actor_label`. Since knowing an
    id is sufficient to fetch, this record of who took a copy is what stands in
    for the access control the pool does not have.
  - `GET /admin/transfers/{id}/content` — the raw bytes, streamed, not the JSON
    envelope. Sets `Content-Type` from the stored mime type,
    `X-Content-Type-Options: nosniff`, and a `Content-Disposition` whose
    RFC 5987 `filename*` carries the uploader's name intact. Audited without a
    broadcast: an operator reading a file changes nothing the console renders.
  - `DELETE /admin/transfers/{id}` — retire one file early. Owner mode commits
    `deleted` metadata and its audit before unlinking bytes; pending filesystem
    cleanup retries after failure or restart. Already admitted downloads retain
    their open descriptor until completion or disconnect. The row and its events
    remain as the audit trail.
- Live agent sessions (`agent_portal.*`) serve Active Clients and Android.
  Dashboard access uses the admin session and its current role capabilities.
  Web Active Clients defaults to Active: ongoing sessions, including offline
  chats, plus unresolved classified notices. Online selects fresh heartbeats;
  needs-you chats are highlighted and activity is shown by labelled avatar icons.
  Retained ended conversations remain readable through session links.
  Server history lasts for the session lifetime plus
  `AGENT_PORTAL_RETENTION_HOURS` after termination (default 24); presence changes
  do not delete history or make an unavailable receiver writable.
  - `GET /admin/agent-sessions` — `{enabled, generated_at, timings, sessions:[…]}`.
    Active Clients cards show the launch name (session name, messaging alias or short session ID when absent), current `cwd`, derived status, bundled Codex/Claude/Grok logo and summary. Names and summaries are searchable; full paths remain available on hover. Transcript-authorized callers also receive `preview:{summary,cursor,created_at}` or null, using the same 160-character, prompt/attention-first summary projection as the companion; other callers receive no preview text.
    `generated_at` is the server instant used for the entire presence snapshot.
    `timings` includes `heartbeat_fresh_seconds`, `relay_fresh_seconds`,
    `working_fresh_seconds` (ten relay windows), and `retention_hours`. Each
    session carries the derived `presence` (`working` / `listening` / `idle` /
    `offline` / `ended`), `active_turn_started_at`, `last_event_at`, any
    outstanding `attention` notice and `pending_prompt`, `relay_enabled` and
    `relay_heartbeat_at` for independent relay aging, plus a `work` block
    joining the Git Director task, branch and declared paths for the worktree
    the session's `cwd` resolved into, and the Agent Messaging address a peer
    would reach it on. Read `presence`, never `status`: the latter is written
    once at registration and never corrected. `enabled` travels with the rows
    because an empty list otherwise cannot be told apart from the module being
    off, in which case registration is discarded server-side and no wrapper can
    ever appear.
    A fresh heartbeat proves online contact only while the host, engine, bridge
    credential, and bridge expiry remain eligible. Missing, malformed, or future
    heartbeats fail closed. Listening additionally needs a fresh enabled relay;
    working needs a recent accepted turn. The same eligibility gates protect
    queued instruction delivery, so a revoked bridge cannot appear writable.
  - `GET /admin/agent-sessions/{id}/events` — one session's timeline, paged with
    `after` / `limit` / `tail`. Carries `user_message` and `assistant_message`
    bodies, so it needs `agent_portal.reveal_transcript` rather than
    `agent_portal.read`.
  - `GET /admin/agent-sessions/events` — the same events fleet-wide as SSE,
    with `event: agent` frames with `Last-Event-ID`
    resume and a 15s heartbeat comment plus an observable `event: heartbeat`
    frame. Optional `session_id=<uuid>` restricts
    the admin stream's SQL read to one session while preserving global cursors.
    Same capability, same payloads. Both streams follow the response socket's
    lifetime and recheck current identity/capabilities while connected; losing
    access ends the stream. API shutdown ends open streams and refuses late
    stream admission; browser reconnects resume after restart. The admin event stream uses a read-only session
    check; normal authenticated requests retain their existing session renewal.
    Metadata-only WebSocket `agent_portal.sessions.changed` events invalidate
    the client query after lifecycle, relay, and timeline changes; heartbeat
    freshness still uses polling and local aging. A reconnect rereads snapshots
    because the admin WebSocket bus does not retain a replay log.
  - `POST /admin/agent-sessions/{id}/messages` — `{client_message_id, content}`;
    queues an instruction for the agent, `202`. Requires a live session and a
    ready relay, exactly as the portal does — the service owns those rules and
    these routes are a thin shell over it.
  - `POST /admin/agent-sessions/{id}/prompts/{promptId}/answer` —
    `{client_message_id, answer, version?}`, `202`. Answering also clears the
    session's outstanding attention notice.
  - `POST /admin/agent-sessions/{id}/close` — `{client_message_id, note?}`;
    queues a cooperative close for the agent to honour, `202`.
  - `POST /admin/agent-sessions/{id}/close/force` — `{client_message_id, note?}`;
    ends a session now, without asking the agent. Unlike the three above it
    writes no queue row, so it is the one that still works when the agent has
    gone offline and can no longer accept a cooperative close — which is exactly
    when an operator reaches for it. Idempotent: a second call on an ended
    session answers `{forced:false, already_ended:true}`.
  - All four author as the signed-in admin. `agent_messages` carries a nullable
    `portal_user_id` and a nullable `admin_user_id` with exactly one set
    (migration `0027`), and the pair is the message's idempotency identity as
    well as its authorship — so a `client_message_id` replayed by a *different*
    actor is a conflict rather than a silent no-op. Delivery re-reads the author
    and cancels the message if that account has since been disabled or deleted.
- `GET /admin/skills` — list stored skills (slug, sha256, display name, description, timestamps) plus canonical `uri` / `canonical_uri`, `managed`, and nullable source provenance. `description` is the persisted short summary used by the runtime AGENTS Skills block when present. Code-managed and source-owned skills are returned with `managed:true`; imported rows use `source_type:"github:mattpocock/skills"`.
- `GET /admin/skills/{slug}` — browser/API split. Browser requests (`Accept: text/html`) receive the admin SPA shell for the dedicated skill workspace page; JSON requests (`Accept: application/json`) fetch full skill content (manifest + metadata, including canonical skill URI, invocation policy, and source provenance).
- `POST /admin/skills/generate` — admin-only runner-backed draft generation. Body: `prompt` (required string) and optional `slug_hint`. Returns a structured skill draft (`slug`, `display_name`, `description`, `tags`, `what`, `when`, `steps`) plus a server-built canonical `manifest`. This endpoint never persists the skill; admins must still call `POST /admin/skills/store` after review. Returns `503` when canonical auth or the runner is unavailable, and `502` when the runner returns unusable output.
- `POST /admin/skills/assist` — admin-only runner-backed conversational draft refinement. Body: `messages` (required non-empty array of `{role:"user"|"assistant", content}`), `skill` (current structured draft fields), and optional `mode` (`new|edit`, default `new`). Returns `assistant_message`, normalized draft fields (`slug`, `display_name`, `description`, `tags`, `what`, `when`, `steps`), canonical `manifest`, `changed_fields`, and runner metadata. Edit-mode requests lock the existing slug even if the runner suggests a rename. This endpoint never persists the skill; admins still save through `POST /admin/skills/store`.
- `POST /admin/skills/store` — create/update a skill (body: `slug`, `manifest`, optional `display_name`/`description`/`sha256`; sha computed from manifest when omitted). Code-managed slugs and source-owned rows cannot be overwritten directly.
- `DELETE /admin/skills/{slug}` — retire a locally authored skill (marks `deleted_at`; hosts remove it on next sync). Code-managed and source-owned skills cannot be deleted through this route.
- `GET /admin/skill-sources/mattpocock` — any authenticated admin role may read source state `{source,repository,ref,enabled,auto_update,status,revision,upstream_version,skill_count,file_count,last_checked_at,last_synced_at,last_error}`. Constants are `source:"github:mattpocock/skills"`, repository `https://github.com/mattpocock/skills`, and `ref:"main"`; `status` is `disabled|ok|error`. Inclusion defaults off, fresh source state defaults auto-update on, an auto-update preference configured while disabled is preserved on enable, and no outbound request occurs while inclusion is off.
- `POST /admin/skill-sources/mattpocock` — owner/admin only. The non-empty body accepts one or both strict booleans `{enabled?,auto_update?}` and rejects unknown keys; returns the same state. Turning inclusion off soft-deletes/hides only rows owned by this source; cached rows, `skill_files`, and last-known-good metadata remain, Codex and MCP-enabled Claude stop listing them immediately; native fallback Claude and Grok prune their fleet-owned directories on their next bootstrap. A later enable validates that complete cached revision and restores it without a GitHub request; a missing, incomplete, or damaged cache instead triggers a fresh import from the immutable upstream SHA. Turning only auto-update off pins the last-known-good revision.
- `POST /admin/skill-sources/mattpocock/refresh` — owner/admin only, with no request body. Force a manual check for an enabled source and return the same state on success. Normal auto-update checks every six hours. A refresh resolves `main` to a commit SHA, imports only the exact `.claude-plugin/plugin.json` paths, fetches all content plus root `LICENSE` at that SHA, validates paths/digests/frontmatter, and commits the complete set atomically. The MIT notice is stored in every bundle as `LICENSE.mattpocock`; a failed check records the error/time but keeps the previous served revision.
- Projects module admin routes:
  - `GET /admin/projects/state` — returns `{ enabled, updated_at, managed_skill:{slug,display_name,description} }`.
  - `POST /admin/projects/state` — body `{ enabled: bool }`; persists module state under `versions.projects_module_enabled`.
  - `GET /admin/projects/feedback` — list feedback across all projects as `{ project:null, feedback:[...] }`.
  - `GET /admin/projects` / `POST /admin/projects` / `GET /admin/projects/{slug}` mirror the host project list/create/detail surface.
  - `POST /admin/projects/{slug}/assist` — admin-only runner-backed project metadata draft. Uses canonical auth plus the current project snapshot (about, roster, recent notes/todos/files/feedback/activity) to suggest improved `about.title`, `about.name`, `about.description`, and optional `roster_markdown`. Returns draft-only data (`assistant_message`, sparse `about`, optional `roster_markdown`, `changed_fields`, runner metadata) and never persists changes; the operator must still save About/Roster explicitly. Returns `503` when canonical auth or the runner is unavailable, and `502` when the runner returns unusable output.
  - `DELETE /admin/projects/{slug}` — hard-deletes the project and all dependent notes/todos/files/feedback/memories/events via FK cascade; returns `{ deleted: slug }`.
  - `GET /admin/projects/{slug}/summary` returns `{ project: { slug, about, roster_markdown, latest_seq, created_at, updated_at, archived_at, counts, feedback_by_type } }` and nothing else — no notes, todos, files or events. The SPA's detail layout runs on every tab and used to call `GET /admin/projects/{slug}`, which carries every file body.
  - `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster`, `POST /admin/projects/{slug}/archive`, `POST /admin/projects/{slug}/unarchive`, `GET /admin/projects/{slug}/files/{id}` (one file with its body, so the console's editor does not have to fetch every body to edit one), `POST /admin/projects/{slug}/feedback/{id}` (triage) and `GET /admin/projects/{slug}/changes` mirror the host `/projects/{slug}/*` surface, as do the note/todo/file/feedback subroutes:
    - Notes: `GET /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes/{id}`, `DELETE /admin/projects/{slug}/notes/{id}`.
    - Todos: `GET /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos/{id}`, `POST /admin/projects/{slug}/todos/{id}/done`, `POST /admin/projects/{slug}/todos/{id}/undone`, `DELETE /admin/projects/{slug}/todos/{id}`.
    - Files: `GET /admin/projects/{slug}/files`, `POST /admin/projects/{slug}/files`, `DELETE /admin/projects/{slug}/files/{id}`.
    - Feedback: `GET /admin/projects/{slug}/feedback`, `POST /admin/projects/{slug}/feedback`.

## Auth + IP rules

- API key is bound to the first caller IP, plus one secondary IP when the host is dual-stack (one IPv4 + one IPv6); subsequent calls from new IPs are blocked unless `allow_roaming_ips` is enabled via admin or `?force=1` on `DELETE /auth`.
- Insecure hosts auto-rebind to the current caller IP while their insecure window is active, so reinstall/rotate flows don’t get stuck on “IP bound” if the host comes back on a new address during that window. The IP check uses only an existing active grant; it neither creates an approval request nor extends the window. After authentication, the route applies its normal retrieve/store window policy.
- Admin endpoints require the admin session cookie. The API never checks a client certificate: `auth-mtls` parses `X-MTLS-Fingerprint`/`-Subject`/`-Issuer` into `req.mtls` and no route reads it, so `X-MTLS-Present` changes nothing. The bundled `caddy` profile (`caddy/Caddyfile`) no longer issues or verifies certificates either — it terminates TLS and reverse-proxies every path alike — so lock down `/admin` via VPN or firewall, or put a proxy of your own that terminates mTLS in front.
- Runner IP bypass: when `AUTH_RUNNER_IP_BYPASS=1` and `AUTH_RUNNER_BYPASS_SUBNETS` contains CIDRs, runner-originated `/auth` validation can proceed without rebinding the stored host IP (logged as `auth.runner_ip_bypass`).
- Runner auth: when `AUTH_RUNNER_SHARED_SECRET` is set on API and `RUNNER_SHARED_SECRET` is set on the runner, API calls to runner include `X-Runner-Auth`; runner rejects missing/invalid secrets with HTTP 401.
- Encryption key: either `ENCRYPTION_ACTIVE_KEY` or the legacy `AUTH_ENCRYPTION_KEY` must hold 32 base64-encoded raw bytes. With neither set the env schema fails and the API does not start, keyring vars alone included.

## Request rates

The orchestrator does not meter request frequency and does not generate local rate-limit responses. Authentication, host/IP rules, insecure-host windows, and API kill switches remain enforced. Deployments that require volumetric controls must provide them at the trusted reverse proxy or network edge.

## Anthropic-compatible API

- `POST /anthropic/v1/messages` — Anthropic-compatible Messages API. `messages[].content` may be a plain string or an Anthropic-style content-block array. Non-streaming returns a standard `message` object. Streaming emits `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, and `message_stop` SSE events. `model` must be one of the supported Claude models returned by `GET /anthropic/v1/models`; when omitted, the API resolves the default from the proxy's `default_model` (`/admin/claude/settings`). Supported body parameters: `messages` (required), `model` (optional), `system` (optional string or text-block array), `stream` (optional bool), `max_tokens` (required, as upstream: missing → 400 `missing_max_tokens`; present but not an integer >= 1 → 400 `invalid_max_tokens`; validated but not enforced, since the `claude` CLI has no output-length flag), `temperature` (optional float 0-1), `top_p` (optional float 0-1), `top_k` (optional int), `stop_sequences` (optional string array). An unknown `model` returns 404 `not_found_error`; an admin-disabled one returns 403 `permission_error`.
- `POST /anthropic/v1/completions` — legacy Anthropic text completions endpoint. `model` uses the same strict allowlist and default-resolution behavior as messages.
- `GET /anthropic/v1/models` — lists the supported Claude model ids from the shared config/model allowlist used by the Anthropic-compatible API: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`. Response uses the Anthropic Models API envelope (`data[].type`/`display_name`/`created_at` plus `has_more`/`first_id`/`last_id`); the OpenAI-shaped `object`/`created`/`owned_by` fields are retained as deprecated aliases.
- `GET /anthropic/v1/models/{model_id}` — retrieves a single model object. Legacy ids resolve to their current-generation replacement; unknown ids return 404 `not_found_error`.
- `POST /anthropic/v1/responses` — Minimal Responses API compatibility adapter for non-streaming clients. Body: `{ input: string|array, instructions?: string, model?: string, stream?: bool }`. When `stream` is `true`, the API returns HTTP 400 with code `unsupported_stream`. The `input` parameter accepts a plain string, a bare content-part array (e.g. `[{type:"input_text", text:"..."}]`), or a message-style array (e.g. `[{type:"message", role:"user", content:"..."}]`). Optional `instructions` are injected as a `system` message. Maps the request onto the Messages backend and returns an OpenAI-compatible `response` object with `output[0].content[0].type="output_text"`. Model uses the same Claude model allowlist; omitted models resolve to Sonnet 5.
- `POST /anthropic/v1/embeddings` — Placeholder endpoint. Anthropic does not support embeddings; returns HTTP 501 with `{type: "error", error: {type: "not_implemented", message: "Embeddings are not supported by the Anthropic backend", code: "not_implemented"}}`.
- `OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions`, `OPTIONS /anthropic/v1/responses`, `OPTIONS /anthropic/v1/embeddings` — CORS preflight for Anthropic routes.

## Admin access control

- Admin routes are protected by the admin session cookie (`requireAdmin`) and, on top of it, by the capability a route is assigned in `api/src/security/route-capabilities.ts` — the plugin refuses to start when a route under `/admin/` or `/cli/auth/` has no entry. No client certificate is checked anywhere: the bundled `caddy` profile terminates TLS without requesting one, and forwarded `X-MTLS-*` headers are parsed but never read by a route. `ADMIN_ACCESS_MODE` (`cookie` default, or `open`) is read only by `/cli/auth/verify`, where anything but `open` requires an admin session; it does not gate `/admin/*`. Passkey/WebAuthn login issues the same session cookie.
- WebAuthn config:
  - `ADMIN_WEBAUTHN_RP_ID` overrides RP ID; otherwise the app prefers the `PUBLIC_BASE_URL` host before falling back to the trusted request host. Setting it also requires `ADMIN_WEBAUTHN_ORIGIN`: the env schema rejects the RP ID on its own, so the API fails to start.
  - `ADMIN_WEBAUTHN_RP_NAME` overrides RP display name.
  - `ADMIN_WEBAUTHN_ORIGIN` overrides the exact expected origin; otherwise the app prefers `PUBLIC_BASE_URL` before deriving origin from the trusted request scheme/host.
- Userless bootstrap: while the user table is empty, only the `capability-after-bootstrap` routes run unauthenticated — `GET /admin/setup/status`, `GET`/`POST /admin/setup/wizard`, `POST /admin/setup/owner`, and `POST /admin/users` — so the first owner can be created. Every other `/admin/*` route needs a session at all times; the moment a user exists those four are gated like the rest.
- Roles: `owner`, `admin`, `fleet_operator`, `trusted_user`, `viewer`, and the legacy `user`. Privileges are not per-role rules but the role→capability matrix in `api/src/security/capabilities.ts` (rendered as a table in [ADMIN.md](ADMIN.md#roles--capabilities) and held to the code by `test/unit/security/capability-docs.test.ts`). In short: `owner` and `admin` hold every capability and differ only in the last-owner invariants; `fleet_operator` adds `hosts.manage`, `hosts.activate_insecure`, `settings.manage`, `auth.manage`, `git_director.manage`, and `transfers.manage` to the read set, but none of `hosts.security_transition` (register/delete a host, change its engines, flip secure/insecure), account management, or any reveal; `trusted_user` is the read set plus `hosts.activate_insecure`; `viewer` and `user` are read-only. How strictly the matrix is applied is `GET`/`POST /admin/authorization` (`compatible` reproduces the pre-matrix gates; `strict` applies the matrix).

## Anthropic-compatible API

Authentication: `Authorization: Bearer sk-ant-...` or `x-api-key: sk-ant-...` header. Runtime validation is surface-scoped: Anthropic-compatible routes accept only `sk-ant-` keys from `/admin/claude/keys`, while OpenAI-compatible `/v1` routes accept only `sk-cdx-` keys from `/admin/openai/keys` — whichever backend engine the surface is routed to (see [Exposed API routing](#exposed-api-routing-any-to-any)).

### Endpoints

- `POST /anthropic/v1/messages` — Send messages to Claude. Body: `{ messages: [{role: "user"|"assistant", content: string|array}], model?: string, system?: string|array, stream?: bool, max_tokens: int, temperature?: float, top_p?: float, top_k?: int, stop_sequences?: string[] }` (`max_tokens` is required; `count_tokens` is the one route that takes the same shape without it). `system` accepts a plain string or an Anthropic text-block array (flattened; `cache_control` accepted and ignored). Content can be a string or an array of content blocks: `{type: "text", text: "..."}` for text, `{type: "image", source: {type: "base64"|"url", media_type?: string, data?: string, url?: string}}` for images. System messages in the `messages` array are extracted and handled separately per Anthropic convention. Supported models: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`. Returns Anthropic message format: `{id, type: "message", role: "assistant", content: [{type: "text", text: "..."}], model, stop_reason, stop_sequence, usage: {input_tokens, output_tokens}}`. When `stream: true`, returns Server-Sent Events with event types: `message_start`, `content_block_start`, `content_block_delta` (with `text_delta`), `content_block_stop`, `message_delta`, `message_stop`.

- `POST /anthropic/v1/completions` — Text completion endpoint. Body: `{ prompt: string, model?: string }`. Returns: `{id, type: "completion", completion: string, model, stop_reason, usage: {input_tokens, output_tokens}}`.

- `GET /anthropic/v1/models` — List available Claude models. Returns: `{data: [{type: "model", id, display_name, created_at}], has_more: false, first_id, last_id}` (plus deprecated OpenAI-shaped `object`/`created`/`owned_by` aliases).

- `GET /anthropic/v1/models/{model_id}` — Retrieve one model object; unknown ids return 404 `not_found_error`.

- `OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions` — CORS preflight. Returns 204 with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type, Authorization, x-api-key, anthropic-version`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`.

### Admin: Claude management

- `GET /admin/claude/keys` — List all Claude API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.

- `POST /admin/claude/keys` — Create a new Claude API key. Body: `{name: string, expires_at?: string, backend_engine?: "codex"|"claude"|"grok"}`. Returns the full key (shown once) and the record. Keys use the `sk-ant-` prefix.

- `POST /admin/claude/keys/{id}/toggle` — Enable or disable a Claude API key. Body: `{active: bool}`.

- `DELETE /admin/claude/keys/{id}` — Delete a Claude API key.

- `GET /admin/claude/state` — Get Claude API enabled/disabled state. Returns `{status, data: {disabled: bool}}`.

- `POST /admin/claude/state` — Toggle Claude API enabled/disabled. Body: `{disabled: bool}`. Requires `settings.manage`.

- `GET /admin/model-defaults/{engine}` / `POST /admin/model-defaults/{engine}` with `engine=claude` — Read/set the Claude Code fleet `settings.json` defaults (`model`, abstract `effortLevel` rendered as native `modelSettings[canonicalModel].effortLevel`). This is the CLI fleet setting, not the Anthropic-compatible proxy default. See the general admin endpoint contract above for the request, response, model capabilities, and 422 validation behavior.

- `GET /admin/claude/settings` — Get the separate Anthropic-compatible API proxy defaults. Returns `{status, data: {default_model, max_tokens, disabled}}`.

- `POST /admin/claude/settings` — Update the separate Anthropic-compatible API proxy defaults. Body: `{default_model?: string, max_tokens?: int}`. Requires `content.manage`. Supported models: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`.

### Anthropic error format

Errors return: `{type: "error", error: {type: string, message: string, code?: string}}` with appropriate HTTP status codes:
- 400: `invalid_request_error` — Missing or invalid parameters
- 401: `authentication_error` — Missing or invalid API key
- 429: `rate_limit_error` — an upstream provider reported quota pressure; the gateway does not originate this response
- 502: `api_error` — Backend/runner communication failure
- 503: `api_error` — Backend not configured or API disabled by administrator

## Agent Messaging

From cxx 0.9.33, fleet guidance and native/relay prefixes recognize authenticated
fleet peers and direct recipients to handle collaboration and delegated work
within existing operator authorization. A chair may coordinate and delegate work;
messages cannot override higher-priority instructions or expand permissions.
Claims and supplied artifacts still need evidence. Replies and publications remain
informational by default, and scheduled wakes retain the schedule creator's
existing authorization. Server-feed publications are identified as an authenticated
fleet source. Host authentication and allowed-window checks are unchanged.

The fourth lifecycle pass (cxx 0.9.29) makes claimed informational replies
atomic with their parent completion. Supplied claims must match the owner and
binding; new replies require a live lease and, before acceptance, a live TTL.
An informational delivery still in flight or ended ambiguously cannot bypass
the claim by omitting it. Unclaimed reads and already completed informational
messages retain their ordinary participant reply path. Identical stored send/reply
receipts remain readable when the recipient is subsequently disabled; this
does not queue a new message. Relay retries reject changed reply content.
Renewal-discovered TTL expiry commits before the API returns its conflict.


### Delivery reliability (cxx 0.9.26)

The second-pass fixes preserve accepted native work across transport reconnects
within the same MCP process and native identity. Reconnection keeps the held
delivery and renews its lease without resubmitting it. Process loss, expired
leases and revoked bindings retain the existing ambiguous-outcome semantics.
Explicit Portal source closure releases its local gate so peers can continue.

For accepted Codex work, a fresh failed or interrupted native turn stops claim
renewal even when watchdog recovery is disabled. The receiver acknowledges the
original claim as `ambiguous`; a lost acknowledgement falls back to lease expiry
only in legacy timed mode. Connection-owned delivery retains the unresolved claim
and replays the same durable receipt, never the action.
An explicit result or reply already awaiting storage confirmation keeps its
original receipt instead. A historical failed turn observed before new queue
admission does not release the new delivery.

Interactive reply/result retries retain the original body and claim even when
a committed completion makes lease renewal return 409. Concurrent reply, result
and listen calls serialize completion for that delivery. Changing an uncertain
payload is rejected locally with recovery guidance; definite validation errors
allow correction. Portal replies likewise retain their original content and
summary until event storage and heartbeat completion are confirmed.
Replaying a stored work reply does not change its original `completed_at`.
Portal acceptance atomically records its supplied upstream turn ID as
`active_turn_id`. The native receiver retries a lost acceptance response with
the same message and lease, requires a confirmed `accepted` status, and submits
without a second heartbeat dependency. Deploy the API before wrapper 0.9.26.

The local MCP `agent_send` and `agent_request` tools accept an
optional UUID `client_message_id`. Keep it unchanged when retrying an uncertain
send; an uncertain send failure also reports the generated ID. A permanent
rejection omits the unchanged-payload retry hint. A successful request followed
by a failed wait returns `sent`, `result`, `wait_error` and `next_action`, so the
caller continues with `agent_wait` on the saved conversation instead of resending.
`agent_wait` `seconds` and `agent_request`/`agent_listen` `wait_seconds` accept 0-25 (default 25); larger values fail `validation_failed`, and the MCP tool schemas and descriptions state this bound.
An empty `result.messages` when the wait window expires is a normal success, not
`wait_error`: the work may still be queued or running. `agent_wait` returns only
messages addressed to the caller, so a peer's outgoing reply is not echoed in
that peer's wait result.
Acceptance of a still-leased message checks its TTL inside the transaction;
expiry cannot be bypassed by beating the maintenance tick. Work already accepted
may finish after its queue TTL. Background workers continue lease renewal through
result storage and retry the same claim/body after a lost completion response,
including when renewal reports that the stored delivery is already terminal.
They never rerun native work to recover a result acknowledgement.

Peer and Portal receive sources keep independent availability: disabling peer
messaging removes its source and binding without breaking Portal heartbeats or
Portal-only reconnects. Re-enabling the peer bus requires a fresh lifecycle
binding. Claude proves its MCP pipes with a matched ping before registration;
Grok SessionStart accepts native `sessionId` as well as `session_id`.

Mailbox metadata includes the reserved Server publisher (`fqdn: null`) and puts
current queued messages before recently expired ones within its 20-row limit.
Automatic `agent_listen` releases a finished delivery and returns health: call it
once, then yield on `automatic`; report `receiver_unavailable` instead of polling.
Report a v2 work result explicitly before release; releasing without one records
`unknown`, never success.
Wrong-source reply tools
name the correct tool for a delivery held by this process: peer messages use
`agent_reply`, operator Portal messages use `agent_receiver_reply`. They do not
silently forward content between sources.

### Scoped publications (migration 0041, cxx 0.9.20)

Persistent groups and single-agent feeds share explicit subscriptions. Topics
are `group:<slug>` (1–64 lowercase ASCII letters, digits, dots, underscores or
hyphens, starting with a letter or digit) or `agent:<address UUID>`. Group creation
does not subscribe anyone. Joining a group enables publishing to it; only the
owner of an agent feed may publish to that feed. Private traffic is never copied.
The Server's reserved publication identity is
`agent:00000000-0000-4000-8000-000000000001`; it is not a provider engine or native
session. Its publications use the durable peer queue; direct operator replies
use the Portal path. Generic native alias/enable controls return
`409 agent_messaging_server_identity_readonly` for this reserved identity; use
the fleet Agent Messaging switch instead.

All session operations below are POSTs beneath
`/host/agent-sessions/:id/agent-messaging/` and require the existing session bridge token:

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /host/agent-sessions/:id/agent-messaging/groups/list` | `{}` | `groups`, `server_topic`, subscription limits |
| `POST /host/agent-sessions/:id/agent-messaging/groups/create` | `{slug,title,description?}` | `created`, `group` |
| `POST /host/agent-sessions/:id/agent-messaging/groups/detail` | `{slug}` | Group metadata and members |
| `POST /host/agent-sessions/:id/agent-messaging/groups/delete` | `{slug}` | `deleted`, `slug`, `topic`, `unsubscribed`, `group` |
| `POST /host/agent-sessions/:id/agent-messaging/subscribe` | `{topic}` | `topic`, `subscribed`, `changed` |
| `POST /host/agent-sessions/:id/agent-messaging/unsubscribe` | `{topic}` | `topic`, `subscribed`, `changed` |
| `POST /host/agent-sessions/:id/agent-messaging/subscriptions` | `{}` | The caller's subscriptions |
| `POST /host/agent-sessions/:id/agent-messaging/publish` | `{topic,content,client_message_id,ttl_seconds?}` | `publication_id`, `topic`, `created`, `recipient_count`, `deliveries`, `skipped` |

The existing engine, address and host gates apply to each publication and
delivery. The transaction snapshots subscribed eligible recipients and queues
the encrypted messages atomically. `client_message_id` is scoped to the sender;
replaying identical topic/content/TTL returns the original receipts, while a
different payload gives `409 agent_messaging_publication_conflict`. The sender
never receives its own copy: when it is itself a group subscriber, `skipped`
lists it as `{address_id, reason:"sender"}` (other skip reasons:
`address_ineligible`), so `recipient_count: 0` with an empty `skipped` means the
topic has no other subscriber. An own feed cannot list the sender, since
self-follow is refused. There is no
wildcard topic. Maximum 64 subscribers per topic, 64 subscriptions per agent,
and 30 publications per minute per sender (`429`, `Retry-After: 60`). TTL uses the
existing 60–604800 second bounds. Publication bodies are limited to 30 KiB UTF-8,
reserving room for the routing header under the 32 KiB delivery limit.
At the next successful subscription attempt, permanently archived/missing
subscribers and retired feed owners (including deleted hosts) are pruned to
reclaim capacity. Disabled, suspended and offline addresses retain subscriptions.
Unsubscribe stops future fan-out; queued
messages keep their original delivery lifecycle.

`groups/delete` (cxx 0.9.91, MCP `agent_group_delete`) hard-deletes a group and
frees its slug for reuse by any creator; there is no archived state. Only the
creating address may delete (`403 agent_messaging_group_forbidden`). Retired
subscribers are pruned first; if any subscriber other than the caller remains,
nothing changes and the call returns `409 agent_messaging_group_members_remain`
with `member_count`. The caller's own subscription, if any, is removed with
the group. Earlier publication rows and queued deliveries keep their lifecycle.
An unknown or already deleted slug returns `404 agent_messaging_group_not_found`,
so a retry after a lost response confirms the deletion.

Publications carry
`kind:"publication"` and a `PUBLICATION/1` header; they need no acknowledgement
reply, and the native receiver completes them through `agent_listen`.

Admin endpoints use the existing `agent_messaging.read` / `agent_messaging.manage`
capabilities: `GET /admin/agent-messaging/groups`, `POST /admin/agent-messaging/groups`,
`GET /admin/agent-messaging/groups/:slug`,
`DELETE /admin/agent-messaging/groups/:slug` (any empty group, including
Server-created ones; same `409` while members remain; audited as
`agent_messaging.group.deleted`),
`GET /admin/agent-messaging/subscriptions`,
`POST /admin/agent-messaging/groups/:slug/publish`, and
`POST /admin/agent-messaging/publish` with the same publication body. Admins
publish as Server to a group or the Server feed; they cannot force-subscribe an
agent. `agent_messaging.groups.changed` and `agent_messaging.subscriptions.changed`
invalidate the central admin queries. Listings expose metadata; plaintext
delivery content retains the separate audited reveal capability.

From wrapper 0.9.19, native receiver prompts and managed fleet instructions treat
received replies as informational by default. Closing acknowledgements finish
through `agent_listen` without an outbound reply; explicit questions, tasks and
substantive active-call turns remain answerable with `agent_reply`. This is model
guidance, not a server restriction on reply chains; no wire format or schema changes.

Agent Messaging is the agent-to-agent bus shared by Codex, Claude, and Grok. Its
`agent_messaging_enabled` fleet switch is seeded off and is the only switch. A
sender and target are eligible only when the fleet switch is on, both addresses
are enabled and unarchived, both hosts are `active` — a secure host outright, an
insecure host only while its `insecure_enabled_until` is in the future — and
each address's engine remains in that host's enabled engine set. These checks are repeated inside the send, bind, claim, and
acknowledgement transactions. The matrix is complete: all nine source/target
pairs across Codex, Claude, and Grok use the same contract.

An agent receives a stable canonical address (`agent:<uuid>`) from the shared
`POST /host/agent-sessions` lifecycle registration. Portal and Messaging keep the
same `invocation_kind` (`interactive`, `execute`, or `peer_delivery`) in their
shared session row, including daemon resumes and registration retries. Optional
scope snapshot failures retain the confirmed registration and return
`scope_context: {enabled:true, protocol:1, available:false, reason:"snapshot_unavailable"}`
when coordination was confirmed enabled (the `enabled` field is omitted if the
setting read itself failed). Authentication and stale binding errors still fail.
The address
is rebound on an exact native-transcript resume. A fresh conversation always gets a new
address, even in the same host/user/engine/cwd. Picker/continue launches recover
the old address only after native identity is reported; `/clear` or another native
identity change switches mailboxes without carrying queued mail, subscriptions or
aliases into the new conversation. Concurrent wrappers cannot bind the same native
transcript. Dormant informational mail without native continuity becomes
`dead` with `native_transcript_missing`; it cannot launch a replacement agent. `POST /host/agent-sessions/{id}/heartbeat` carries adapter capability,
receive readiness, upstream-session continuity, and a generation fence.
`POST /host/agent-sessions/{id}/finish` unbinds the address, clears receive
capability, and leaves it `resumable` when an upstream session is known or
`offline` otherwise. Only a persistent host resumes a `resumable` address
headless; elsewhere its mail waits for a human to restart the agent and expires
after its TTL. The scoped bridge bearer is kept by `cxx` and proxied to
the engine over its private Unix socket.

In owner mode, the persisted bridge credential bootstraps an authenticated
attachment; its effective authorization deadline can renew in RAM while current
host/security/binding proof remains valid. Reconnect may renew the same bootstrap
credential through a finite host-authenticated command, never revive an ended
lifecycle or extend an insecure grant from pings. The following timed abandonment
behavior applies only to the legacy path: a bridge lease lasts
`AGENT_PORTAL_BRIDGE_TTL_SECONDS` (default 900), renewed by the 15-second heartbeat
(cxx backs off to 60 seconds while the API is unreachable). A lapsed lease is recoverable: the bridge answers
`agent_bridge_expired` and the wrapper registers the same session ID and token
again. The portal's abandonment sweep ends a session whose lease lapsed (status
`failed`, event `server:abandoned`, address unbound). It waits 150 seconds after
an API start, so wrappers that outlived an API outage renew before they are swept.
An ended lifecycle is never revived, even with its own credential: every bridge
call and re-registration answers `409 agent_session_finished`, which cxx treats
as terminal. The response carries `ended_reason` (`abandoned` | `finished`) and
`recovery: "resume_native_conversation"`. The message names the route: exit the CLI
and resume the same native conversation in a new managed launch. The exact resume
rebinds the same address (next binding generation, native continuity) and needs no
fresh-start approval, which stays limited to operator-approved replacement deliveries.

Session-bound operations require `X-Agent-Bridge-Token`:

From cxx 0.9.59, registration accepts optional `workspace` with absolute `cwd`,
`git_status` (`repository|none|unavailable`), nullable `git_root` and
`git_common_dir`, and optional nullable `origin_url`. Repository status requires
both Git paths; other statuses require null paths and no origin. The wrapper
resolves symlinks locally and honors Codex `-C/--cd` and Grok `--cwd`, including
on managed resume. Git probes are local and bounded to two seconds. Origin
userinfo, query and fragment are removed before transmission; the API persists
only SHA-256 of the Git Director-normalized network remote. Local filesystem
remotes never establish a cross-host match. Registration retries refresh supplied
metadata; omitted metadata preserves the existing value. Old sessions remain valid.

- `POST /host/agent-sessions/{id}/agent-messaging/list` — discover eligible
  peer addresses, excluding the caller, optionally filtered by engine or host.
  Optional `scope` is `fleet` (default), `directory`, `checkout` or `project`, always relative
  to the authenticated caller. Directory matches canonical cwd on the same host.
  From cxx 0.9.62, Checkout matches the same canonical `git_root` on the same
  host, including subdirectories but excluding linked worktrees. It returns
  `checkout_root` (nullable), falls back to directory matching without caller
  Git-root metadata, and marks coverage limited if the caller has no Git root
  or any eligible local peer has missing/unavailable workspace metadata.
  Unknown peers on other hosts do not limit checkout coverage. Legacy peers
  still match exact cwd, with limited coverage. Use `online:true` in MCP or
  `include_offline:false` in HTTP to exclude offline sessions; all engines count.
  Project also matches the same common Git directory on that host or the same
  normalized network origin across hosts. Each session is independent, even
  when several agents use one directory; Git Director registration is unnecessary.
  Scope filtering precedes pagination. Results add `scope`, `effective_scope`,
  `observed_at` and `coverage: { limited, peers_without_workspace }`. Project
  queries fall back to `effective_scope: "directory"` when the caller has no Git
  metadata. `limited` flags missing/unavailable caller metadata or eligible peers
  without it; the count describes the eligible population before scope/name filtering.
  A known non-Git caller falls back without itself marking coverage incomplete.
  Legacy peers retain matching by reported cwd; no repository identity is guessed.
  Each address adds `task_title` (latest naming event for the bound native session,
  or null), canonical `cwd` when known, and `match_reason`
  (`fleet|same_directory|same_checkout|same_clone|same_repository`). No conversation content is returned.
  `name` (1–96 characters) matches a literal, case-insensitive substring of launch
  name, alias or canonical address before paging. Each address carries a
  derived `presence` (`listening` | `online` | `resumable` | `offline` |
  `disabled`), computed from the bound session's heartbeat against
  `AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS`, not from the stored `readiness`
  column. `include_offline: false` (the `online: true` MCP argument) filters on
  that derived value, so only `listening` and `online` — an address with a
  wrapper actually behind it — are returned; `resumable` means a session ended
  and could be resumed (automatically only on a persistent host), not that
  anyone is home. `readiness` remains on the wire
  for compatibility and is **not** a liveness signal: for a session that never
  calls `agent_listen` it is written once at registration and not again until
  finish. Results are ranked reachable-first then most-recently-seen, with
  canonical address as a tie-breaker. `limit` defaults to 50 (range 1–50);
  `offset` defaults to 0 (non-negative safe integer). `total` counts all filtered
  peers. When more remain, `truncated: true` and `next_offset` point to the next
  page; pass that value as `offset`. Ranking is live rather than a snapshot, so
  peer activity can move rows between pages. Prefer `name` for a known peer.
  `listening`/receiver `ready` prove healthy transport, not an idle native turn:
  held deliveries and busy native threads delay claiming until released/idle.
  A short queue TTL can expire with zero attempts during that delay.
- `POST /host/agent-sessions/{id}/agent-messaging/send` — enqueue a new message
  or request. Body includes `to`, UTF-8 `content`, UUID `client_message_id`, and
  optional `conversation_id`, `ttl_seconds`, and `kind` (`message|request`).
  Send and reply receipts add `recipient_presence` (`listening|online|resumable|offline|disabled`),
  `observed_at` (RFC3339), and human-readable `delivery_hint` at the response root.
  Presence is a fresh snapshot, including on idempotent retries; `resumable` means
  offline with an existing native conversation. `message.status=queued` proves
  server storage only, never recipient acceptance or reading.
  Local messaging tools show operation/error code without internal session
  paths. Uncertain transport/server errors and HTTP 408/429 retain the same-UUID
  retry hint; permanent 4xx rejections require correcting the request instead.
- `POST /host/agent-sessions/{id}/agent-messaging/reply` — append a reply to a
  message using a new sender-scoped idempotency UUID.
- `POST /host/agent-sessions/{id}/agent-messaging/wait` — conversation-ordered
  long poll (`seconds` 0..25, default 20) after a sequence cursor.
- `POST /host/agent-sessions/{id}/agent-messaging/message` — fetch one
  participant-visible message by UUID. Message metadata (here, in send/reply
  receipts, wait and digest results, and the admin message views) carries nullable
  `sender_session_id`, the lifecycle (`agent_sessions.id`, the `session_id`
  `agent_self` reports) that wrote the row; it is null for server-originated
  rows. One address is shared by every process of a launch (sub-agents and
  receiver turns use the same broker) and by later lifecycles an exact resume
  rebinds, so this field is what tells "my launch" from "another launch under my
  UUID". A send is accepted only from the lifecycle currently bound to the
  sender address (`agent_messaging_binding_stale` otherwise).
- `POST /host/agent-sessions/{id}/agent-messaging/cancel` — cancel an open
  participant conversation and all queued/leased messages in it.
- `POST /host/agent-sessions/{id}/agent-messaging/mailbox` — peek the queue for
  this session's address: what is waiting, and what expired unanswered in the
  last 30 minutes. Strictly read-only (no lease, no status transition, no
  attempt burned) and, unlike `deliveries/claim`, it does **not** require
  receive-capability — an agent that has never called `agent_listen` is exactly
  who needs it. Carries sender identity and `expires_at`, never message bodies.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/open` — open a conference
  (`ttl_seconds` 300..21600 default 3600, `max_members` 2..8 default 8), mint a
  room PIN valid to the room's deadline, and return the caller's address as
  `self`. One open conference per owner; re-opening returns it with `reused`.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/list` — body `{}`. The
  caller's live rooms (not adjourned, before deadline) where it has a member row
  that has not left: chair, `invited`, `seated` or `dispatched`. Per room:
  `conference_id`, `topic`, `purpose`, `status`, `deadline_at`, `created_at`,
  `max_members`, `member_count`, `chair` (address/name/alias/engine/fqdn), the
  caller's `role` and `state`, `messages_used`, `messages_budget`. At most 50,
  oldest first. Membership-scoped: rooms the caller was never invited to or
  joined are not listed, and the PIN is never returned (the chair gets it from
  `conf/open`, which reuses the open room). An agent may sit in several rooms,
  including chairing one and participating in others.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/invite` — chair only.
  Creates a member row and queues an `INVITE` per address. The `INVITE` does not
  count against the invitee's twelve-message budget; its `HELLO` on join is its
  first charged message. Idle agents on persistent
  hosts are woken by their relay with the invite as the prompt (other hosts run
  no relay, so the invite waits for a live receiver until its TTL); a host with a wrapper attached is
  skipped by the relay and receives through its native receiver or manual listen. Per-member
  results — the fan-out is a loop, not a transaction.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/join` — exactly one of
  `pin` or `conference_id`. The PIN is **multi-use** and is never consumed by a
  join; `conference_id` admits only an already-invited
  member. Invitations reserve capacity as `state: invited`, `joined_at: null`;
  they receive no broadcast or task until they call join. Joining sets the
  actual `joined_at`, changes state to `seated`, and queues `HELLO` to the chair.
  Both join forms require the chair's current derived presence to be `listening`.
  Otherwise they return `409 agent_messaging_conference_chair_not_listening`
  before creating a member or queuing `HELLO`. The room and PIN remain available
  for retry after the chair's receiver recovers.
  Rejoining an active member preserves its original join time and dispatched
  state. Historic pre-0047 rows retain their recorded timestamps.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/roster` — any member. Host
  and engine are joined from `hosts`/`agent_bus_addresses`, not stored per member.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/say` — chair broadcasts to
  every `seated` member (`dispatched` members are skipped, being mid-task) or to
  one named member; a participant's `to` is ignored since the star has no
  participant-to-participant edge.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/dispatch` — chair only.
  Optional `eta_seconds` is the chair's estimate, an integer 0..14400 (default
  900); anything else is rejected as a validation error, never clamped. It is carried
  unchanged in the `CONF/1 TASK … eta=<s>` header and echoed as `eta_seconds`.
  Separately, the member goes `dispatched` with a `dispatch_deadline_at` that the
  maintenance sweep uses to un-strand a member whose run died: the grace is
  `max(eta_seconds, 900)` (returned as `grace_seconds`), because a headless run
  spends most of a short window booting an engine, and the deadline is capped at
  the room deadline. The response also returns `dispatch_deadline_at`.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/adjourn` — chair only.
  Default leaves `dispatched` members to finish and parks the room in
  `adjourning`; `force: true` cancels their conversations, which revokes the
  delivery lease. Headless workers stop on renewal failure; already running
  interactive native work and committed side effects may continue.
- `POST /host/agent-sessions/{id}/agent-messaging/bind` — heartbeat/bind the
  native adapter with `binding_generation`, continuity, upstream session, and
  receive-capability state.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/claim` — claim one
  delivery with an idempotent UUID and optional 0..25 second long poll.
  Optional `informational_only: true` leaves work queued without spending a
  delivery attempt or bypassing FIFO; one-shot CLI readers use this mode.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/renew`
  — validate the exact owned claim; connection-owned grants need no durable heartbeat renewal. Legacy timed grants extend their 60-second lease.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/ack` —
  report `accepted`, `completed`, `retry`, `dead`, or `ambiguous` for the owned
  claim.

One outbound-only background relay is registered per host user, and only on a
persistent host (host daemon `resident_enabled`, or remote starts enabled and
not expired; `daemonResident()`). For any other host, register, heartbeat and
claim answer `503 agent_messaging_relay_not_persistent` (503 so pre-0.9.82
workers back off instead of retrying fast; 0.9.82 workers exit cleanly), while
stop, renew, reply and ack stay open so in-flight work can finish and be
recorded. The daemon relay keeps its own remote-starts check (`daemonAccepting()`)
on register and, from 0.9.92, on heartbeat and claim: an idle daemon relay is
refused `403` as soon as the daemon is disabled, expired or migration-fenced;
one with running sessions or leased/accepted peer work keeps both until it
drains, without new work. See
[host runtime policy](host-runtime-policy.md). Registration
uses normal host API-key/IP policy and returns a generation-fenced 15-minute
bearer; subsequent calls require `X-Agent-Relay-Token`. The relay never opens a
listener and never claims an address while its interactive, receive-capable
session is attached.

Daemon relays use the reserved `<username>:daemon` identity with authenticated
`host_daemon: true` capabilities. An accepted native child binds as the exact
unsuffixed service user; registration retains the message claim, relay generation,
host, target address and native transcript checks. Ordinary relays require an exact
username match and cannot acquire daemon semantics by adding the suffix.

- `POST /host/agent-relays/register` — register/replace the per-user relay and
  return its id, generation, token, expiry, and polling interval.
- `POST /host/agent-relays/{id}/heartbeat` — renew relay heartbeat and token
  expiry.
- `POST /host/agent-relays/{id}/stop` — stop the generation and erase its token.
- `POST /host/agent-relays/{id}/deliveries/claim` — long-poll for one eligible
  dormant address delivery. Empty polls wait for in-process message/admission events
  with a two-second fallback for external changes. Every request first runs its own
  authenticated claim. Later iterations for the same relay and token can share
  only a still-running empty-queue check at a common timer boundary. Completed
  results are discarded; work and errors go through each waiter's own fenced
  claim. Ordinary future retries and accepted work do not require the locked
  path; expiry, leases and notice cleanup still do. Execution parallelism and
  the absolute long-poll deadline are unchanged. For dormant targets, certainly
  unpresented digest roots are canceled as tombstones and their unexpired batched
  originals restored without changing IDs, content or dispatch order. Live leases
  and accepted/presented/ambiguous groups are preserved; the target binding is
  checked again under lock before recovery. Candidate targets are identified in
  one set read, so unrelated dormant addresses incur no per-address recovery locks.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/renew` — extend the
  relay-owned lease.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/reply` — atomically add
  the delivery reply while preserving claim and native-session continuity.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/ack` — acknowledge the
  relay-owned delivery with the same outcome vocabulary as session delivery.

When a target becomes receive-ready again, valid waiting direct messages/replies
produce one bundled `presence_notice` per returning target session and currently
online sender session. Manual and automatic resumes count; receiver readiness,
not mere launch registration, triggers the notice. The notice includes the stable
address, current name, observation time and waiting message IDs in its content.
Queued and leased mail count; the resumed launch's already-accepted relay delivery
also counts because the worker accepts before launch. Other accepted, expired or
canceled work does not count. Offline senders at the return are not notified later.

Notices originate from the reserved Server address and are informational, with no
work contract or reply. `target_session_id` binds them to that one sender session;
ending/replacing it cancels outstanding notices before FIFO selection. Relays
cannot claim notices and admins cannot redrive them. Transport retries retain the
same notice ID; repeated receiver registration/heartbeats do not create duplicates.
Finish a notice with `agent_listen` once; never acknowledge it with another message.

Delivery is ordered at least once. A monotonic dispatch key and conversation
sequence provide per-target FIFO; a delayed retry remains head-of-line, and no
target may have more than one leased or accepted message. Claims and sender
`client_message_id` values are idempotent. Legacy timed leases last 60 seconds;
owner-mode grants are connection-owned and are not released by silence or timestamp expiry. Retries use
bounded exponential backoff, and the twelfth attempt is terminal `dead`.
Backoff fences the delivery path that failed, not the message: a live session's
claim ignores `next_attempt_at` on a row whose last delivery session was another
one or none (the relay's `native_session_busy` retries), so a returning session
is never held behind backoff it did not cause; its own retries keep theirs.
Messages are at most 32 KiB UTF-8. TTL defaults to 24 hours and accepts 60
seconds through seven days. Expired queued rows become `expired`; legacy timed leased rows retain their expiry handling. Connection-owned held work is not released by TTL alone.

Acceptance is a deliberate uncertainty boundary: after the target has accepted
work, a lost completion acknowledgement or eligibility shutdown preserves an
uncertain outcome rather than replaying work automatically. Legacy timed accepted
lease expiry becomes `ambiguous`; connection-owned work retains its claim through
disconnect/restart until authoritative completion or explicit resolution.
Only an owner/admin may explicitly redrive a `dead` or `ambiguous` message; the
redrive is a new queued row and conversation sequence linked by
`redrive_of_message_id`, while the terminal original remains unchanged.

Message bodies and recorded delivery errors are secretbox-encrypted. Admin
address, conversation, and message listings return metadata only. Any active
authenticated admin role, including viewer/legacy read-only roles, may read
that metadata; every mutation and plaintext reveal requires `owner` or `admin`:

- `GET /admin/agent-messaging/state` — fleet state, eligible/live counts,
  queues, and all nine engine-direction summaries.
- `POST /admin/agent-messaging/state` — toggle the default-off master switch.
- `GET /admin/agent-messaging` — SPA/JSON address inventory compatibility path.
- `GET /admin/agent-messaging/addresses` — address/host eligibility and queue
  depth without message content.
- `PATCH /admin/agent-messaging/addresses/{id}` — set or clear the unique
  human alias.
- `POST /admin/agent-messaging/addresses/{id}/enabled` — enable/disable one
  address; enabling rechecks every upstream gate.
- `GET /admin/agent-messaging/conferences` — metadata for the newest rooms; optional
  `status=open|adjourned` (`open` includes `adjourning`; omitted means all),
  `limit=1..500` (default 100). Includes chair, active/total members and last activity.
- `GET /admin/agent-messaging/conferences/{id}` — room metadata and all members,
  including departed members, fleet-derived host/engine/presence, dispatch delivery
  status/error, task deadline, last report, and message budget. The room PIN is omitted.
- `GET /admin/agent-messaging/conferences/{id}/messages` — merged metadata timeline
  from the members' stored conversation IDs, including ordinary replies. `limit=1..100`
  defaults to 100; use either `before` or `after` with a positive safe integer
  `dispatch_order` cursor. No cursor returns the latest page; `before` returns its
  preceding page; `after` returns the next page. Each response is chronological and
  includes `oldest_cursor`, `newest_cursor`, and `has_more` in the requested direction.
- `POST /admin/agent-messaging/conferences/{id}/reveal` — body
  `{ "message_ids": ["uuid", ...] }` (1..100 IDs); all IDs must belong to that room.
  Returns those messages with decrypted `content`. Requires
  `agent_messaging.reveal_content`; records `agent_messaging.conference.revealed`
  with actor, room and message IDs only, without broadcast, and sets no-store headers.
  Conference GETs require `agent_messaging.read`. These routes never claim,
  acknowledge, sweep, or alter work, and remain usable when messaging is disabled.
- `GET /admin/agent-messaging/conversations` — metadata listing, optionally
  filtered by status and bounded to 1..500.
- `POST /admin/agent-messaging/conversations/{id}/cancel` — cancel an open
  conversation.
- `GET /admin/agent-messaging/messages` — metadata-only listing, optionally
  filtered by conversation UUID/status and bounded to 1..500.
- `POST /admin/agent-messaging/messages/{id}/reveal` — explicit audited
  plaintext reveal. Responses set `Cache-Control: no-store` and
  `Pragma: no-cache`, and reveal events are audit-only rather than broadcast.
- `POST /admin/agent-messaging/messages/{id}/redrive` — explicitly create a new
  delivery from a `dead` or `ambiguous` row.
There is no per-host gate: the fleet switch is the only switch, and an insecure
host is authorized per operation against its allowed window.

Disabling the fleet, an address, a host engine, or a host's active status
atomically cancels queued/leased work, marks accepted work ambiguous, cancels
affected conversations, revokes relays where applicable, and generation-fences
session bindings. A closed allowed window is deliberately not one of these: it
refuses calls with `agent_messaging_insecure_window_closed` and leaves the
queue to drain when the window reopens. A graceful session finish unbinds without deleting its stable
address, and the relay process handles SIGINT/SIGTERM by stopping its server
generation. Version 1 performs queue maintenance and state transitions only:
terminal messages, canceled conversations, dormant addresses, and their audit
history are retained; there is no automatic Agent Messaging history purge.

### Legacy timed-path idle relay FIFO observation

An idle relay uses the same strict FIFO readiness predicate as its authoritative claim. A due queued follower behind an earlier queued message or accepted/leased/reboot-held work does not start an empty claim transaction. Completion or the head becoming due makes normal delivery eligible on the next observation. Expired messages, lease reconciliation, routine-notice retirement and safe digest recovery still enter their existing locked paths. This observation caches no authorization or queue results.

Waiters sharing one credential join only an in-flight idle check on a 10-second
grid. After the last grid point before the request deadline they wait for that
deadline or a work event; they do not revert to faster polling. Every new request
performs its own admission check, and committed work wakes parked requests.

### Legacy timed-path idle coordination maintenance

The following polling/checkpoint optimizations describe the retained legacy path.
Owner mode uses RAM projections, change subscriptions and indexed deadlines; it
does not run these SQL idle checks, heartbeat checkpoints or periodic sweeps.

An active resource claim owned by the current, present binding can be read or
renewed inside the existing bus transaction without reconciling every fleet
member. Waiting, expired, uncertain, foreign and conflict-response paths still
reconcile. The background reconciler continues to enforce expiry and membership.

An unchanged secure daemon heartbeat checkpoints its timestamp with generation,
connection, metadata and secure-host predicates. A raced predicate falls back to
the locked path; insecure-window renewal and changed metadata remain transactional.
Daemon retention, queue expiry and idle/question timeouts run on the shared
60-second sweep, rather than also scanning on each heartbeat. Beats do not count
as session activity. Timeouts can therefore be applied up to one sweep later.

The companion push worker checks durable pending outbox deadlines and device
event cursors before constructing session rosters. Its five-second tick still
observes new events, approvals and retry deadlines; authorization and notification
deduplication remain in the original delivery path. Pairing and notification
retention run once per minute independently of whether notification work exists.


## Agent sessions

Active Clients and paired Android devices provide operator chat. The legacy `/go`
magic-link webchat and portal-user APIs are removed. Shared `agent_portal.*`
capabilities, the saved switch and wrapper/Android contracts remain unchanged.
Active Clients separates Agents and Remote sessions, with a shared native conversation view.
Remote start/continue/stop reuse the existing daemon endpoints; `/admin/clients?remote=<id>`
selects a daemon session and existing `?session=<id>` links resolve its native binding.
The Agent sessions master switch lives at `/admin/settings#agents`; its API is unchanged.

### Host registration and bridge

- `GET /host/agent-portal/state` — host-authenticated master-switch probe.
- `POST /host/agent-sessions` — host-authenticated registration for an eligible interactive or human-started execute session. The wrapper retains the short-lived bridge bearer and gives the engine only a private Unix-socket path/session ID; inherited portal variables are scrubbed.
- `POST /host/agent-sessions/{id}/heartbeat` — scoped-bearer heartbeat/rolling expiry renewal. A liveness-only beat (no status, turn or relay change, presence still fresh) is answered from the authenticated row and its `heartbeat_at`/`bridge_expires_at` are persisted by the liveness ledger within 10 s, one single-row autocommit update per row; receiver and relay heartbeats follow the same rule. `relay_action=poll` opens/touches the instruction relay and `relay_action=close` closes it and cancels undelivered session work, except a `close`-kind note the agent has already leased: `cxx portal leave` is how an agent acts on a close, so its own leave must not cancel the instruction it is obeying.
- `POST /host/agent-sessions/{id}/events` — scoped-bearer idempotent safe event publish. The server forces `source=engine` and accepts only session-named/assistant/progress/waiting/terminal-block/attention/attention-resolved types; answerable waits require a stable prompt UUID. `attention_resolved` accepts only an optional `payload.summary` (trimmed and truncated to at most 1000 UTF-8 bytes; other payload fields are discarded) and withdraws the same session’s prior attention notice without answering a pending prompt or changing relay/session state. Like every safe event, it requires the session’s bridge bearer and a stable `client_event_id`; retry returns the original event cursor and cannot dismiss newer attention.
- `POST /host/agent-sessions/{id}/finish` — idempotent, atomic completed/failed event + terminal transition + pending-work cancellation; makes the session read-only.
- `POST /host/agent-sessions/{id}/commands/claim` — strict FIFO long poll with `{wait_seconds?: 0..25, claim_id: UUID}` and a retryable 30-second lease; repeating the same `claim_id` while its lease is live returns the same item without incrementing attempts. Older leases/backoff always block newer work.
- `POST /host/agent-commands/{messageId}/ack` — explicit acceptance/retry acknowledgement. `cxx portal wait` does not acknowledge: the model issues `portal accept` only after it has received the structured instruction, so an unaccepted lease is redelivered. Accepted state and the visible `message_accepted` event commit in one transaction. Acceptance requires an unexpired owned lease; an accepted receipt replays only for the same `lease_owner`, `accepted` outcome and normalized `upstream_id`. The stored owner remains receipt correlation after `lease_until` is cleared. A superseded claim or changed receipt returns `agent_message_lease_lost`; accepted rows from older releases without a retained owner cannot prove a replay and are rejected rather than restarted.

Admin API:

All mutations below require an `owner` or `admin` role; authenticated viewers
may read state and users but cannot change rollout or identity state.

- `GET /admin/agent-portal/state` — switch, configuration, queue health, and dead-letter counts.
- `POST /admin/agent-portal/state` — toggle the global switch. Turning it off cancels queued/leased operator input without replay and closes relays.

## Provider quota recommendation

`GET /admin/quota-mode` additionally returns `advice`; `POST /admin/quota-mode`
accepts the same object alongside the existing enforcement fields. Omission preserves
stored advice, so older admin clients do not reset it. Invalid input is rejected
before any quota setting is written. The object is stored atomically as JSON under
`versions.quota_advice`; no schema migration is required.

| Advice setting | Default | Accepted values |
| --- | --- | --- |
| `mode` | `ask` | `off`, `hint`, `ask` |
| `high_usage_percent` | 85 | Integer 1–100 |
| `projected_usage_percent` | 100 | Integer 100–500 |
| `min_pressure_gap` | 20 | Integer 1–100 |
| `max_age_minutes` | 30 | Integer 1–120 |
| `remember_day` | true | Boolean |

Auth retrieve/store and `/sync/status` / `/sync/bootstrap` auth responses include
optional `quota_advice: {settings, codex, claude}`. Each provider contains
`available` (host engine membership), `status`, original `fetched_at`,
`limit_reached`, and `windows: [{used_percent, limit_seconds, reset_at}]`.
Null readings remain null. The optional field is specified in the existing
auth and sync response schemas. Codex windows refer only to the host's active
normal/Spark lane. This field contains no credentials and reads stored snapshots
only: no provider requests and no renewal of observation timestamps. Availability
is not an authentication verdict; the chosen provider must pass normal startup.

For each valid measured window, pressure is the greater of
`100 * used / high_usage_percent` and `100 * projected / projected_usage_percent`.
Projection uses the observation time and requires at least five minutes and 1% of
the window to have elapsed. The provider's worst window determines its pressure;
a reported provider limit sets a floor of 100. Recommend the alternative only when
the current provider reaches 100, the alternative is below 100, and the difference
meets `min_pressure_gap`. Missing/error/stale timestamps, invalid percentages and
passed/inconsistent resets prevent comparison. Unknown reset times permit only
absolute-usage comparison. Corrupt persisted settings disable advice.

Settings are central; remembered selections are local to an OS user and
orchestrator URL. `off` and `hint` never apply remembered selections. Advice does
not relax existing authentication, local credential handling or quota hard-fail.

## Automatic receiver protocol (0.8.10)

`POST /host/agent-sessions/{id}/receiver/register`,
`POST /host/agent-sessions/{id}/receiver/heartbeat`,
`POST /host/agent-sessions/{id}/receiver/stop`,
`POST /host/agent-sessions/{id}/receiver/ack`,
`POST /host/agent-sessions/{id}/receiver/status` and
`POST /host/agent-sessions/{id}/receiver/claim`
use `X-Agent-Bridge-Token`, the existing session/host/engine authorization, and the
applicable peer/portal switch. No host credential is sent to the model process.

- `register`: `{generation: UUID, protocol: "codex-queue-v1"|"claude-channel-v1"|"grok-acp-v1", native_session_id}`;
  returns public `receiver` evidence and the connection's stored `sources`.
  Retrying a generation with a different native identity returns
  `receiver_registration_conflict`; enabling another source does not silently
  add it to an existing registration. A live owner cannot be
  replaced. Same-generation retries are idempotent.
  Optional `capabilities.claim_gate_v1: true` negotiates bounded claim-gate telemetry;
  the response echoes the connection's stored `capabilities.claim_gate_v1`.
- `heartbeat`, `stop`: `{generation}`, optionally `failure` on stop. Native health
  expires after 45 seconds and cannot be revived; reconnect with a new generation.
  A negotiated heartbeat may include `claim_gate: {state, seconds}`. `state` is
  `unknown|open|held_delivery|work_active|portal_pending|thread_active|thread_waiting|thread_other`;
  `seconds` is an integer from 0 through 604800, sampled at the heartbeat. Other
  fields and unbounded native status text are rejected. Omission clears prior
  gate evidence; a new generation starts without it. Stop/ack do not accept it.
- `claim`: `{generation, source: "peer"|"portal", claim_id: UUID}` returns an existing
  queue `delivery` (peer) or `message` (portal), possibly null. It never returns a probe.
  Queue transactions check generation again before leasing ordinary work; manual
  claims cannot race the automatic owner. Enabled sources need no model acknowledgment.
  Empty peer polls and presence-return checks use one nonlocking database snapshot
  of admission, binding, receiver health and queue absence. They avoid global bus
  and host-row locks only when that snapshot certifies a valid empty result.
  Pending/expired deliveries, waiting presence notices and uncertain or invalid
  admission retain the existing locked path, error handling and delivery fences.
  An empty claim is held for up to 8 seconds and answered again, once, as soon as a message, this session's portal, or a fleet switch event is published; otherwise it returns empty when the hold ends. Changes without an event (lease expiry, retry due) are seen on the next claim.
- `ack`: deprecated compatibility endpoint for already-delivered old probes. Requires
  a matching generation/source/nonce and delivered legacy probe on a healthy connection.
  Returns status without changing stored evidence, renewing health, or reviving a receiver.
- `status`: `{}` returns `receiver` with state, generation, native session ID,
  protocol, last native-health heartbeat, failure and per-source transport state.
  Legacy source `delivery_id`, `delivered_at`, `acknowledged_at`, and `latency_ms`
  fields remain present but null. No model-response proof is inferred from readiness.

From cxx 0.9.118, a fresh negotiated receiver also exposes `claim_gate`,
`claim_gate_seconds`, `claim_gate_observed_at` and an explanatory `claim_gate_note`
through status, admin listings and `agent_list`. These describe the last 15-second
heartbeat snapshot; they do not renew independently or change transport readiness,
claim authorization or native scheduling. `thread_*` means the next delivery waits
for the native thread to become idle; `work_active` permits only informational
coordination while accepted work remains active. `unknown` is the initial snapshot
before a local gate has been observed. Failed, stale or unnegotiated receivers omit
gate evidence. A ready receiver with a closed gate can normally leave messages queued
at zero attempts; that is not proof of a stalled transport. Wrappers omit heartbeat
extensions when unsupported, and registration retries retain compatible older queue
capabilities before falling back to a legacy registration.

`POST /admin/agent-sessions/:id/receiver/verify` remains the compatibility route for the
**Reconnect receiver** action, with existing operator/manage capability and origin
protections. They invalidate the generation and return `{reconnect_requested: true,
verification_requested: true}` (the second key is legacy). Reconnection is silent;
there is no manual chat probe. Ordinary session heartbeat does not renew receiver
health. Admin/peer/portal listings return the same public `receiver` evidence.

Portal maintenance expires open unanswered questions with a registered receiver
after its stop or 45 seconds without a fresh native-health heartbeat, including
when the wrapper's bridge heartbeat continues. It rechecks readiness under the session lock
before expiring the prompt and incrementing its version. A recovered receiver,
an armed reboot handoff or a durable Companion Remote binding preserves the
question. This cleanup leaves the session and classified notices intact and runs
on the next maintenance sweep, not at the exact instant of process loss.

The private local broker additionally implements `receiver/native`, used only by
the Claude SessionStart hook and adapter to exchange actual native identity; it is
not an HTTP API route. All local receiver operations require the signed
`agent_messaging.receiver_enabled` grant.

## Provider accounts and launch reservations

Operator-consolidated duplicate account IDs remain same-engine compatibility aliases: auth/bootstrap, launch reservations and Claude usage reports resolve them to the surviving account, including for existing live session IDs. Aliases never appear as separate available accounts.

ChatGPT (`codex`) and Claude (`claude`) have independent account pools. Provider identities identify accounts; access/refresh fingerprints identify credentials and login lineage, not distinct subscriptions. Migrated identities are recovered from their canonical head when `identity_key` is unset. Fresh opaque tokens reuse the sole non-retired engine account or their explicit session/host assignment. A distinct provider identity can enroll another account automatically; additional opaque accounts require explicit `POST /admin/accounts` or an untargeted seed command. With multiple accounts, an unassigned opaque upload returns HTTP 409 `account_assignment_required` without creating an account. Replacing a known account can explicitly supply `account_id`; known cross-account identity/lineage conflicts remain HTTP 409 `account_identity_mismatch`. Existing runner validation, quarantine, generation/CAS, replay protection and secretbox encryption apply within each account.

- `GET /admin/accounts` — session-gated metadata list: `accounts[]` with `id`, `engine`, `label`, lifecycle state, verification verdict/reason/time, generation, normalized short/weekly quota percentages, reset times, observation time/staleness, and active host sessions. Never returns credential bytes or provider identity fingerprints. The same URL serves the Accounts SPA for HTML navigation.

  Codex and Claude usage also include nullable `short_limit_seconds` and
  `weekly_limit_seconds`. Codex readings, durations and resets are projected
  together from the latest successful account snapshot, by duration rather than
  primary/secondary slot: below seven days is short, at least seven days is
  weekly. Missing readings remain null, including in weekly-only snapshots;
  zero is a valid reading. Claude durations are 18000/604800 seconds when the
  corresponding reading exists. These additive display fields need no database
  migration; older clients can keep using the existing percentages and resets.
- `POST /admin/accounts` — `{engine, payload, label?}`; `payload` is auth JSON text or a Claude API key. Live-validates enrollment and returns account ID and verdict metadata.
- `PATCH /admin/accounts/:id` — `{label?, state?: "enabled"|"paused"}`. Paused accounts accept same-account refreshes for existing sessions but receive no new scopes.
- `POST /admin/accounts/:id/credentials` — `{payload}`; validates replacement for the specified engine/account. Known different account identities cannot overwrite it.
- `POST /admin/accounts/:id/verify` — live runner verification; returns verdict metadata only.
- `DELETE /admin/accounts/:id` — stops new assignments immediately (`removing`); after sessions release (or legacy timed grants expire), clears encrypted payload bodies and auth entries and retains an identity tombstone (`removed`).
- `POST /auth/sessions` — host-key/IP/security gated `{engine, scope_id, session_id, account_id?, ownership_mode?}`. IDs are opaque strings of 16–64 characters; `scope_id` represents the native auth directory. Returns `ownership_mode` plus verified `auth`, `account_id`, `account_label`, `session_id`, `expires_at`, `canonical_digest`, `canonical_last_refresh` and existing quota controls. Omitting `ownership_mode` selects renewable timed ownership for legacy clients; `connection` explicitly opts into provider-stream ownership. Retries preserve the mode of the existing grant. Retries with one session ID are idempotent. An optional account ID supports retaining an already active native child, rather than a user pin. The initial Grok access projection uses this freshly acquired, unexpired host/account grant before its provider stream is attached; this bootstrap allowance is server-internal and does not authorize reactive renewal without a live connection.
- `POST /auth/sessions/heartbeat` — `{engine, session_id}` validates a connection-owned reservation from RAM without a durable renewal. Negotiated clients stop this polling after authenticated connection ownership is confirmed. For legacy timed reservations only, it extends a live, host-owned lease by five minutes; expired/foreign sessions are rejected with 404. Wrappers heartbeat every 90 s (cxx 0.9.121; 30 s before) and answer a 404 (a host that slept past the TTL) by re-reserving the same `session_id` through `POST /auth/sessions` with their `scope_id` and bound `account_id`, discarding the returned auth; a lease landing on another account is released and retried on the next tick. Paused, unverified, or removed accounts refuse the re-reservation.
- `POST /auth/sessions/release` — `{engine, session_id}` idempotently releases that host's reservation and drains pending removal.

Admin mutations require `auth.manage`; listing requires `auth.metadata.read`. All host routes retain the API kill switch, engine membership, host/IP authentication and insecure credential-distribution window. `/auth` and `/sync/bootstrap` accept `account_id` and advertise `account_pool: true`; returned digests, generations, verdicts and quota readings belong to that account. `/claude/usage/report` accepts `account_id` and `session_id`, rejecting a mismatched binding.

Before a launch reservation, a host's saved account ID is a discovery hint: a recognized login for another provider identity enrolls or refreshes that identity instead of overwriting the saved account. Active session IDs and explicit admin replacement targets remain strict. Opaque Claude refreshes without a different recognized identity retain the saved account.

Selection runs once per native CLI launch. It prefers verified enabled accounts with lower short/weekly utilization below the configured quota threshold; readings within five percentage points share assignments by active session count, then least recent selection. Unknown/reset accounts get bounded trials to obtain usage. Stale utilization stays conservative until its reset; reset windows become unknown rather than fabricated zero usage. Active sessions retain their account, including overlapping launches sharing native files. If all known quotas are exhausted, existing hard-fail/warn and VIP behavior still governs the selected account. There is no cross-engine fallback or manual host pinning.

### Provider subscription plans

`GET /admin/accounts` includes an account-scoped `plan` object for every engine:
`{name: string|null, source: chatgpt_usage|claude_login|grok_settings,
observed_at: string|null, stale: boolean}`. ChatGPT plan names come from that
account's successful usage snapshot `plan_type`; Claude names come only from
`claudeAiOauth.subscriptionType` in its verified canonical login, with
`rateLimitTier` distinguishing Max 5×/20×. Claude observation time is the stored
payload's creation time, not a live billing check. Unknown types remain null;
quota sizes, selected models and account labels never determine a plan.
Metadata older than ten minutes, missing timestamps and failed settings polls
are stale. No credential fields are returned in `plan`.

Migration `0069_provider_plan.sql` adds Grok's cached plan name, observation time
and sanitized plan error to `grok_usage_snapshots`. The existing five-minute
account poll also reads `https://cli-chat-proxy.grok.com/v1/settings`, using the
same fenced access bearer, engine/account gates, ten-second timeout and redirect
refusal as billing. `subscription_tier_display` is preferred over known
`subscription_tier` values, following [official Grok Build RemoteSettings](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-config/src/remote_settings.rs).
Plan and quota freshness are independent: a settings failure retains the previous
plan as stale; a successful response with no recognized plan clears the old name.
No additional Claude provider request or wrapper update is needed.

### Grok subscription usage

`GET /admin/accounts` adds `usage.current_window` for Grok: `{used_percent, period: weekly|monthly|null, starts_at, resets_at, shared}` or `null` when no provider reading exists. `usage.supported` is true; `fetched_at` is the last successful reading, `checked_at` the last attempt, and `error_code` is a sanitized failure code. `stale` is true after ten minutes, after the provider period expires, or on a failed poll; failed polls retain the last successful window. Missing percentages never become zero. Legacy `short_*`/`weekly_*` fields stay null for Grok: this is a dashboard observation and does not change account selection or wrapper quota contracts.

The API background worker polls `https://cli-chat-proxy.grok.com/v1/billing?format=credits` at most once per five minutes per account, with a ten-second request deadline and redirects refused. It wakes every thirty seconds for new accounts; disabled engines, paused/removed/merged accounts are skipped. Bearers come only from the existing fenced Grok auth owner. `accounts.updated` invalidates the existing admin queries after each observation. No billing write or top-up operation is performed. The endpoint is provider-owned and not a stable public xAI API contract; unavailable/changed responses remain visibly unknown or stale.

## Grok endpoint inventory

- `OPTIONS /grok/v1/*` — CORS preflight, without gateway auth.
- `POST /grok/v1/chat/completions` — Grok subscription chat completion, scoped bearer required.
- `POST /grok/v1/responses` — Grok text response, scoped bearer required.
- `POST /grok/v1/completions` — Grok legacy text completion, scoped bearer required.
- `POST /grok/v1/embeddings` — Unsupported endpoint, explicit non-retriable400.
- `GET /grok/v1/models` — Enabled Grok native model catalog.
- `GET /grok/v1/models/:model` — Retrieve an enabled native model.
- `GET /admin/grok/keys` — List Grok gateway keys without credential bodies.
- `POST /admin/grok/keys` — Issue a scoped sk-cgx- gateway key, returned once. Body: `{name: string, expires_at?: string, backend_engine?: "codex"|"claude"|"grok"}`. Omitted `backend_engine` retains endpoint-default routing.
- `POST /admin/grok/keys/:id/toggle` — Change a Grok gateway key active state.
- `DELETE /admin/grok/keys/:id` — Remove a Grok gateway key.
- `GET /admin/grok/state` — Read the independent Grok API switch.
- `POST /admin/grok/state` — Set the independent Grok API switch.
- `GET /admin/grok/settings` — Read gateway default_model and disabled.
- `POST /admin/grok/settings` — Change gateway default model/switch; unsupported parameters rejected.
- `GET /admin/grok/models` — List native catalog with enabled flags.
- `POST /admin/grok/models/:model/toggle` — Enable/disable a Grok gateway model.
- `GET /admin/grok/config` — Read engine-specific managed config metadata, including canonical `revision` (string, or `null` when missing).
- `GET /admin/grok/config/retrieve` — Retrieve engine-specific managed config.
- `POST /admin/grok/config/render` — Preview native TOML config.
- `POST /admin/grok/config/store` — Save managed Grok config with the shared optional `expected_revision` guard; returns the saved `revision`.
- `GET /admin/grok/version` — Read Grok CLI version metadata.
- `GET /admin/grok/version/lock` — Read the independent exact CLI pin.
- `POST /admin/grok/version` — Set/clear the independent exact CLI pin.
- `POST /admin/hosts/:id/grok-version` — Set/clear a host-specific Grok CLI pin.
- `POST /admin/runner/run-grok` — Run a read-only subscription verification with no credential bytes returned.

## Android companion

The native Kotlin app uses `/companion/v1` with a separate Bearer device credential;
admin cookies and browser Origins are not accepted there. It is paired from the
signed-in Account → Android devices screen. Each credential belongs to that admin
and receives only their current capabilities, enforced strictly on every request.
Device credentials expire after one year; pairing again creates a new device.

- `GET /admin/companion/devices` — own devices, timestamps and push configuration readiness; requires `account.self_manage`.
- `POST /admin/companion/pairings` — own single-use five-minute QR JSON (`version:1`, HTTPS `server`, random `token`); creates an audit entry and replaces outstanding codes for that user.
- `DELETE /admin/companion/devices/{id}` — revoke an owned device and clear its FCM token; audited, publishes `companion.devices.changed`.
- `POST /companion/v1/pair` — `{token,name}` exchanges a QR token once for `{device_id,token,firebase,capabilities}`; the token is never logged or stored in plaintext.
- `GET /companion/v1/hosts` — `admin.read`; daemon-enabled host cards with `host_id`, `fqdn`, `default_cwd`, ready `engines`, safe `health`, `free_slots` and `startable`. No credential/runtime payloads.
- `POST /companion/v1/daemon-sessions` — `{host_id,engine,client_message_id,task?,title?,cwd?}`; requires messaging management plus Portal read/manage/transcript permissions. Empty task establishes contact only. Returns 202 `{operation_id,session_id}`; UUID is retained across retries. Rechecks host/engine readiness and capacity under the daemon lock. Owned remote conversations are projected in `/agents` with their logical ID and `daemon_session:true`; existing events/messages/answers/follows routes span or resume their bound Portal launches. Missing transcripts and unknown outcomes never trigger a replacement start.
  Queued/running/stopping sessions project `presence: offline` when daemon health
  is stale or disconnected, unless a usable bound Portal relay remains. Stored
  `remote_status` and work outcomes are unchanged. Daemon health revision changes
  invalidate both `hosts` and `agents` WebSocket scopes, each filtered by its
  existing capability, so remote conversation cards refresh automatically.
- `GET /companion/v1/me` — identity, current capabilities, public Firebase configuration, notification preference, and followed session IDs.
- `PATCH /companion/v1/device` — optional `fcm_token` (nullable), `notifications` boolean, `visible_session_id` (nullable UUID); updates last-seen time. Visible-session suppression expires after 45 seconds.
- `DELETE /companion/v1/device` — self-revoke on logout.
- `GET /companion/v1/agents` — portal snapshot (`agents`, `generated_at`, `timings`), using `agent_portal.read`. With transcript permission, each agent also has `preview: {summary,cursor,created_at} | null`; open questions/attention take priority over the latest assistant reply. Independent numeric `reply_cursor` is the latest `assistant_message` event ID, or 0 when none; prompt/attention priority never changes it. It remains available for retained offline/ended conversations. Summaries are whitespace-normalized and limited to 160 Unicode characters. A reply lacking a summary uses a neutral notice, never an older preview or full response excerpt. Without transcript permission, preview and reply cursor are null. Device-local reply-read watermarks use `reply_cursor`, never the preview cursor or lifecycle timestamps.
- Native naming: the scoped-bearer `/host/agent-sessions/{id}/events` endpoint accepts `type:"session_named"` with `payload:{name:string}` (trimmed, required, at most 1000 UTF-8 bytes; an optional `only_if_missing:true` atomically returns an existing name instead of replacing it; optional `native_session_id` fences native reports against the current binding, returning `agent_session_name_stale` on mismatch; other fields discarded). The session-bound `agent_session_name` MCP tool uses this mode so the AI can supply a missing name while preserving known names. These encrypted, idempotent events change neither session state, prompt/attention ownership nor unread reply counts, and never trigger push. GET/POST `/companion/v1/agents` project the latest name for the current native binding as `session_name` (normalized to 160 Unicode characters), null when missing or without `agent_portal.reveal_transcript`. Requires wrapper 0.9.32 for native naming metadata and Android 0.4.6 for display; older clients remain compatible.
- `POST /companion/v1/agents` — additive read-only snapshot using the same `agent_portal.read`, transcript projection and enabled-portal gates as GET. Body `{read_cursors:{"session UUID":cursor}}` accepts at most 500 UUID keys and safe nonnegative integer values (numeric or decimal strings, JavaScript safe integer limit 9,007,199,254,740,991); malformed/unsafe/oversized maps return 400. Unknown session IDs are ignored. Both snapshot methods include numeric `unread_reply_count`: the count of that session's `assistant_message` events whose global event ID exceeds its supplied local read cursor (default 0), or 0 with no replies. Without transcript permission it is null. Counts use parameterized metadata aggregation, excluding all other sessions/event types; they are never cursor subtraction. No read marker is persisted or acknowledged by this request, and reading still requires the reply to be rendered on the device.
- `GET /companion/v1/agents/{id}/events` — bounded timeline, `after` cursor and optional `tail=1`; requires `agent_portal.reveal_transcript`.
- `GET /companion/v1/ws` — native Bearer WebSocket, independent of `ADMIN_WS_ENABLED`. Sends `{type:"hello",ts}`, `{type:"changed",scopes:["me"|"agents"|"approvals"],ts}`, and `{type:"ping",ts}`. Scopes are capability-filtered invalidations for the existing REST reads, never admin event bodies or transcript text. A shared five-second reconciliation covers time-based state changes; ordinary changes publish immediately. Rechecks credentials/permissions and the global API kill switch, emits heartbeats every 15 seconds, and closes slow/disconnected clients. Revocation closes with 4001; transient/disabled service uses 1013. Reconnect refreshes snapshots and resumes the selected transcript by cursor.
- `GET /companion/v1/events` — legacy resumable foreground SSE using `after` and optional `session_id`; rechecks device/account authorization and portal state each page, closes slow readers. Retained for older APKs.
- `POST /companion/v1/agents/{id}/messages` — `{client_message_id,content}`, returns 202 and follows this conversation. Reuses the portal's UUID idempotency and live-receiver checks.
- `POST /companion/v1/agents/{id}/prompts/{promptId}/answer` — `{client_message_id,answer,version?}`, returns 202, preserves first-answer-wins and follows the conversation. Both writes require `agent_portal.manage`.
- `PUT /companion/v1/agents/{id}/follow` — `{followed}` changes reply notifications for this device; requires transcript access.
- `GET /companion/v1/approvals` — current host-access `requests` plus default/max duration, currently 480 minutes; requires `hosts.activate_insecure`. Also returns `active_windows: [{host_id,fqdn,enabled_until,domain_allow}]` for insecure hosts with future deadlines, sorted by FQDN/ID, independently of daemon/engine readiness. `domain_allow` is a matching active domain name or null; a domain grant may reopen a host after individual disable. `fleet_window: {open,enabled_until}` exposes the fleet state, with a null deadline when absent. Dates are UTC ISO strings; secure, closed and expired host windows are excluded. Window changes share the `approvals` WebSocket scope and owner state/deadline notifications.
- `POST /companion/v1/hosts/{hostId}/insecure/disable` — `hosts.activate_insecure`; no body required. Reuses single-host disable: clears grant/grace, blocks session renewal and returns `{host_id,enabled_until:null}`. Repeated close is safe. Missing host returns 404; an open fleet window returns 409 `insecure_fleet_window_open`. Independent domain grants retain their existing reopening behavior.
- `POST /companion/v1/insecure/window/close` — `hosts.activate_insecure`; no body required. Reuses manual fleet close, clearing all standing host grants and active domain allows, including permanent allows. Returns `{closed,hosts,domains}`; `closed:false` means no stored fleet window was removed or a concurrent reopen won, and clients must refresh. Both close operations audit the authenticated administrator and paired device as `actor:{admin_user_id,device_id}`. Android 0.4.17 confirms the fleet-wide effect before calling this route.
- `POST /companion/v1/approvals/{requestId}/approve` — optional `{duration_minutes}` in 0–480, defaults to 480. Rechecks expiry under the same lock as dashboard decisions; stale/conflicting decisions return 409.
- `POST /companion/v1/approvals/{requestId}/deny` — deny the current pending request; same capability and concurrency rules as approval.

Host access approves the existing insecure-host window; it does not grant agent
tool/command approvals. Finished conversations remain readable under portal
retention. Agent/engine switches and receiver readiness retain their existing
meaning; ordinary chats never wake engines; explicit remote starts and resumptions use the enabled host daemon and retain host assignments.

The owner compares committed portal event heads and per-device cursors in RAM. Source changes and actual retry/expiry deadlines wake the durable notification worker; an idle fleet performs no notification scans. It notifies ordinary questions and replies for followed conversations, plus explicit
important/critical/blocker notices for eligible devices regardless of follow state, skips
routine activity, and sends opaque IDs plus the source event's short `summary`
through FCM for agent notifications. Agent payloads additionally carry optional
`event_cursor`, a decimal string identifying the exact outbox source event;
approvals omit it. Retries preserve the same event cursor even if newer replies
arrive. Reply badges compare it with device-local read watermarks; push receipt
does not acknowledge a reply. REST snapshots reconcile suppressed/missed pushes
and older payloads without this field. Full response text is never sent. The optional
summary uses the existing encrypted event payload; no schema migration is needed.
Jobs have unique source
keys, up to eight proven-safe send attempts, and expiry capped at the request's
five-minute deadline or one hour for chat. A durable dispatch intent precedes FCM I/O. Ambiguous network outcomes remain uncertain and are not automatically sent again; the app deduplicates notification IDs. Invalid FCM registrations are removed. Every send
rechecks the device, administrator capabilities and source state immediately before sending. Foreground presence and last-seen observations stay in RAM; disconnects do not require durable heartbeat writes. No browser
needs to remain connected. See [Android setup](android-companion.md).

## Agent Wake / Cron schedules

- `GET /admin/schedules` — paginated definitions (`limit` 1..200, default 100; `after=next_cursor`), without prompts. Requires `agent_messaging.read`; an HTML request serves the SPA.
- `GET /admin/schedules/:id` — definition including prompt and latest 100 executions. Requires `agent_messaging.read`.
- `POST /admin/schedules` — create; requires `agent_messaging.manage`.
- `PATCH /admin/schedules/:id` — partial update with required current `version`; stale versions return `409 schedule_version_conflict`. Requires `agent_messaging.manage`.
- `DELETE /admin/schedules/:id` — soft-delete with JSON `{version}`; cancel queued work, retain accepted work and history. Requires `agent_messaging.manage`.
- `POST /host/agent-sessions/:id/schedule-policy` — bridge-authenticated current-session watchdog policy. Returns nullable `progress_timeout_seconds` and binding generation; requires a current unexpired bridge, eligible host/engine, enabled persistent schedule, active work and no open operator prompt. This never grants remote PID control.

MCP exposes `schedule_list`, `schedule_get`, `schedule_create`, `schedule_update`, `schedule_delete` to authenticated fleet hosts. Every eligible agent may manage all fleet schedules, with actor IDs in audit records. The managed `wake-cron` Skill is shared across Codex, Claude and Grok and ships with the API image.

Create fields: `name`, stable `target=agent:<uuid>`, `prompt` (max 30000 UTF-8 bytes), `kind=once|cron|interval`, exactly one corresponding timing field (`at` future RFC3339, `cron` five fields, `interval_minutes` positive integer), `timezone` (default Europe/Berlin), `enabled` (default true), `persistent` (default false), `progress_timeout_seconds` (60..604800, required only for persistent recovery). PATCH accepts changed fields plus version; switching timing kinds must clear obsolete timing fields. Invalid combinations fail validation.

Ordinary schedules await a live receiver; their messages can never be claimed by a headless relay. Explicit persistent schedules use the per-user cxx-agent worker and exact native-session resume adapters for all three engines; they exist only for agents on persistent hosts, and creating or enabling (`enabled` and `persistent`) a schedule whose target agent's host is not persistent is refused with 403 `schedule_host_not_persistent` ([host runtime policy](host-runtime-policy.md)). No transcript means blocked, never a fresh-session fallback. Work for an ended agent without a running host worker stays queued until its TTL (24 hours) and then expires. No host power-on is performed. Every interval wakes healthy idle sessions too; one unfinished execution per schedule coalesces downtime and busy intervals into one follow-up. Bus FIFO, process writer locks and binding/lease generations prevent concurrent native writers.

Owner mode schedules indexed due obligations and serializes durable commands; the legacy scheduler uses a ten-second DB-locked pass. Payload and recovery policy are snapshotted per execution. Recovery after ambiguous crash may repeat external effects and is visibly counted. Capacity failures wait at least the configured interval (five minutes for cron/once); recognized structured provider retry/reset hints extend that wait. No implicit engine switch. Spring nonexistent fixed-hour Cron times are skipped; repeated autumn local times run once. Pause/delete cancels queued work and future recovery but leaves accepted work running.

Wrapper 0.9.21 observes native output and Linux process activity. Only the wrapper that created a process may stop it, after an explicit progress timeout and a fresh policy/binding check; TERM precedes KILL by ten seconds. Active child tools count as ongoing work, and a wrapper heartbeat does not count as progress. Idle sessions and open operator prompts are protected. Linux /proc is required for automatic hang termination; other platforms retain crash/capacity recovery without guessing process health. Fleet API/messaging/engine and host gates remain authoritative. The UI shows waiting, queued, leased, accepted, completed, recovering, capacity_wait, blocked and terminal error states; acceptance alone is not successful task completion.

### Work outcomes and recovery (execution contract v2)

Wrapper 0.9.22 advertises `execution_contract_version: 2`. Newly queued requests,
conference TASK dispatches and wakes wait for a compatible adapter; informational
traffic and already accepted legacy executions remain compatible. The worker and
live/listen adapters confirm durable acceptance before exposing work. Missing native
transcripts stop ordinary jobs too: replacement requires an explicit operator request,
then `agent_fresh_start_approve(message_id, version, reason)` or the admin fresh-start
operation. Grants are bound to the message and target binding, consumed once on acceptance,
and forbidden for schedules. Ordinary ambiguous executions are never automatically rerun.
An approved replacement receives a new default 24-hour queue TTL and a fresh
delivery-attempt budget, even if the original message expired while awaiting the
operator. Repeating the same approval preserves that deadline and budget; it
does not extend them. Prior terminal timestamps are cleared for the new execution.

**Result reconciliation after a lost lease.** Accepted work whose lease lapses (the
claim renewal stopped, for example because a same-transcript rebind changed the
address binding generation or the session ended) becomes `ambiguous` with
`last_error_code: accepted_lease_lost` after the next maintenance tick. The claim and
lease owner are cleared on purpose: `agent_task_result` and `agent_reply` for that
claim answer `agent_messaging_lease_lost` or `agent_task_result_not_accepted`, and the
new binding or session is never handed the old lease. The server has no route that
attaches a late result to the ambiguous row, and it does not rerun the work. The
supported reconciliation is out-of-band: the executing agent sends its measured
outcome to the original requester with `agent_send` in the same conversation (name the
message id and state succeeded, failed, blocked or unknown honestly), and the requester
reads the row with `agent_message_get` (`status: ambiguous`, `last_error_code`,
`task_results: []`) plus that message. The requester or an operator then decides whether
to accept the reported outcome or to explicitly redrive the message
(`POST /admin/agent-messaging/messages/{id}/redrive`), which is a new execution and
may repeat external effects. A first-class "attach late result" mechanism is a larger
design question (it needs an authorization model for a new binding to claim an old
execution) and is not implemented.

From cxx 0.9.27, `agent_conf_join` and `agent_conf_say` release only the
matching room's informational delivery. They preserve held work and messages
from other rooms. Rejoining preserves a dispatched member's state and deadline;
progress updates do not reopen its seat for another task. A session work reply
requires `claim_id` from its durably accepted delivery, including when no
explicit result is supplied (which records `unknown`). Missing claims or work
not yet accepted are rejected; old receipt retries still verify the stored result.
Portal acceptance rejects an expired 30-second claim before maintenance runs;
receipt retries must match the accepted owner, outcome and upstream ID.
Automatic `agent_listen` also requires a registered peer source: healthy Portal
transport alone returns `receiver_unavailable`, with `peer_source_unavailable`.

`agent_task_result(message_id, task_result)` completes accepted work; `agent_reply` may
include the same result and completes work atomically with the reply. A claimed reply
with `delivery_class: progress` and no `task_result` is a non-terminal status update:
the work stays `accepted` and held, so later progress and the real result still succeed
(the wrapper sends `progress` even without negotiated `queue_delivery_v1`). Any other
reply without `task_result` finishes the work as `unknown`. A result contains
`status` (`succeeded|failed|blocked|unknown`), `summary` (4096 UTF-8 bytes maximum) and
optional `evidence` (up to 20 `{description, reference}` objects). Bodies are encrypted;
metadata lists only the status. Per-claim writes are idempotent; a different result conflicts.
Native background final output is one JSON object with `content` and `task_result`.
Missing/invalid reports, listening and successful process exit never imply task success.
These are agent-reported outcomes, not independent verification.

Persistent schedules optionally accept `max_recovery_attempts` (null: unlimited).
Retries double from the base interval, cap at max(base, 1h), add 0–20% positive jitter
and honor later provider reset times. Three failed recovery attempts raise a warning;
exhausting the limit pauses the entire schedule with `pause_reason: recovery_limit_reached`.
Explicit re-enabling starts a new run and counter; history remains. Domain failure alone
never starts recovery. Pause/delete prevents pending attempts while accepted work continues.
The canonical fleet AGENTS guidance and shared Wake / Cron Skill describe these rules.

Stale wake-ups retire themselves. Every 10 minutes the schedules worker sweeps schedules
(not watchdogs) whose target agent has been gone for 24 hours — the same grace an agent
name stays reserved: its session ended or its bridge expired, or the address is archived
or missing. A finished one-shot (`once`, no further wake) is deleted 24 hours after its
last run; a recurring one is paused with `pause_reason: agent_gone` and its waiting work
canceled (Enable restores it). Persistent schedules are left alone while their address
exists, since resuming a dormant agent is their purpose. Actions are recorded as
`schedule.expired` / `schedule.paused_agent_gone` admin events by `system:sweep`.

- `POST /admin/agent-messaging/messages/:id/fresh-start` — requires agent_messaging.manage; closed body `{version, reason}`, authorizes one ordinary replacement session after native_transcript_missing. Wakes are rejected; version conflicts return 409; repeated identical approval is idempotent.
- Delivery ACK bodies additionally accept `task_result` only with `outcome: completed`. Session replies accept `claim_id` and `task_result`; relay replies accept `task_result`. Atomic result/reply/transport updates reject stale claims and binding generations. Reveal includes encrypted report history through the existing reveal-content capability.

A result-only peer completion also queues one correlated reply containing its summary in the same transaction; wakes produce no peer reply. Retrying the same result never queues a second summary.

Git Director registrations require absolute worktree, repository and common-directory paths (`git rev-parse --path-format=absolute --show-toplevel --git-common-dir`). A correct re-registration supersedes earlier mappings for that host/path and withdraws their queued requests while retaining history. A live lease on an earlier mapping blocks reassignment. Join/list/merge/release never select an arbitrary legacy duplicate: `git_director_worktree_ambiguous` requires explicit re-registration with the correct clone facts. Superseded rows cannot be revived by path lookups.

## German launch names and translation

With Agent Messaging enabled, each new managed Codex, Claude or Grok launch
gets a random free German female given name from the server's pre-filled pool
of 664 names (including Claudia, Tanja, Jessica and Paula). Allocation is
transactional and idempotent for a launch ID. The session title is
`(Claudia) Task title`; the task title is preserved separately.

New conversations receive a name; resuming the same native transcript restores
its original recorded name and UUID, including picker/continue resumes discovered
by the receiver. Same-launch bridge recovery preserves its confirmed name. Exit
or bridge expiry starts a 24-hour quarantine; offline presence alone does not.
A resume can reclaim its own name during quarantine or after expiry while free.
If another identity owns the name or its quarantine, registration returns HTTP 409
`agent_resume_name_conflict` with `name`, `uuid` and `address`; no replacement name
is allocated. Direct resumes stop before provider startup; late receiver binding
is refused without activating delivery. Retry once the name is free. Names remain
reusable after 24 hours, so keep UUIDs for durable references. Existing renamed
identities restore their earliest surviving name on their next native resume.
From cxx 0.9.37, messaging-enabled launches require a confirmed name before
starting the native provider. Registration advertises `launch_identity_version: 1`;
an exhausted pool returns `agent_name_pool_exhausted` and rolls back allocation.
Older wrappers can still receive `name: null`; names are never duplicated.
Legacy records remain unnamed until launch registration.

`cxx agent translate Claudia` prints the canonical UUID;
`cxx agent translate <uuid>` (also `agent:<uuid>`) prints the current/latest
name. Add `--json` for name, UUID, address, launch ID, active/ended status and
quarantine timestamps. Outside a managed launch it uses the installed signed
host configuration without registering a launch. Inside one it uses the
private session broker. MCP exposes `agent_translate` with `{value: string}`.
Names are case-insensitive; German umlauts accept their `ae`/`oe`/`ue` spellings.

Message/request recipients and conference invitation recipients accept names
directly. Accepted messages and invitations persist the resolved UUID and
historical names, including receipt retries after reuse. An expired unassigned
name returns `agent_name_not_found`; UUID lookup still returns its latest
historical assignment. Manual aliases cannot claim pool names; pre-existing
alias collisions keep the affected name out of allocation.

Read-only lookup surfaces (all use the same resolver):

| Endpoint | Authentication | Input |
| --- | --- | --- |
| `POST /host/agent-messaging/translate` | Host API key and host/IP/window policy; an active assigned engine | `{value: string}` |
| `POST /host/agent-sessions/:id/agent-messaging/translate` | Session bridge token | `{value: string}` |
| `GET /admin/agent-messaging/translate` | Admin session and `agent_messaging.read` | `?value=Claudia` |

Response: `{name, uuid, address, session_id, status, started_at, ended_at,
cooldown_until, direction}`. `direction` is `name_to_uuid` or `uuid_to_name`.
Messaging and target-host/engine eligibility gates apply to every surface.
Receiver registration also returns nullable `identity` (version 1, name, UUID, address,
launch/native session IDs, engine and binding generation). Wrappers use it to
refresh provisional picker identity and bridge recovery immediately. Historical
assignments remain available through `agent_self.previous_names`.
Launch registration adds `address.name` and `name_status`
(`assigned|unavailable`); agent-address projections add nullable `name`.
Session snapshots add nullable `launch_name`, `task_title`, `session_name`.

#### Host-scope agent inventory (read-only)

`POST /host/agent-messaging/list` lets an operator shell outside any managed
lifecycle enumerate the agents registered on its own host. Authentication is the
host API key with host/IP/window policy (an insecure host needs an open window).
The body is closed: `{engine?: "codex"|"claude"|"grok", include_offline?: boolean}`
(default `true`); `scope`, `host_id`, `limit` and `offset` are rejected with 422,
because the key authenticates exactly one host and the listing is pinned to it.
It sends, claims and renews nothing.

Response: `{scope: "host", read_only: true, enabled, host_id, fqdn, observed_at,
total, addresses[]}`. `enabled` reflects the messaging master switch; rows are
returned either way so an operator can still decide whether a worker is safe to
stop. Each address carries the public address projection (`name`, `engine`,
`username`, `cwd`, `presence`, `readiness`, …) plus `receiver`,
`current_session_id`, `upstream_session_id`, `last_upstream_session_id`
(resumability), `engine_active` (false while the engine is fleet-suspended or
unassigned), `queue_depth` (live messages: queued, leased, accepted,
reboot_hold), `accepted_work` (accepted work still awaiting a result) and
`queue` (counts by status). Archived addresses are omitted; disabled ones are
listed with `presence: "disabled"`.


### Confirmed launch identity (cxx 0.9.37)

Before any messaging-enabled provider starts, the wrapper confirms its name,
engine, launch ID and canonical address with the authenticated session-bound
`POST /host/agent-sessions/:id/agent-messaging/self` (`{}` body, bridge token).
The response contains `identity_version: 1`, `name`, `uuid`, `address`,
`session_id`, nullable `native_session_id`, `engine`, `binding_generation`,
`previous_names` for this address and nullable `task_title` for the current binding.
MCP exposes the same read-only lookup as `agent_self` without arguments.
Ended, expired, disabled or stale bindings cannot read another launch's identity.
Update the API before installing wrapper 0.9.37; a missing endpoint, API outage,
empty name or mismatched confirmation refuses the native launch. Signed
messaging-disabled local launches retain their previous behavior.

The confirmed name and launch ID are passed per launch through Codex
`developer_instructions`, Claude `--append-system-prompt`, or Grok `--rules`.
Existing developer/append instructions are preserved; shared AGENTS/config files
never contain a launch identity. Claude resumes use `--system-prompt-snapshot off`
so the prior launch's stored identity is not replayed as the current system prompt.
The context does not state the agent address. It is fixed before the provider
starts, and a later native binding (a picker/continue resume, `/clear`, or another
reported native identity) can rebind the launch to another address while keeping
the launch name and launch ID, so `agent_self` is the only source of the address.
The agent is instructed to read `agent_self` at startup and after resume/recovery.
Delivery of context does not prove that a model obeys instructions.

Server and Android session labels remain `(Name) Task title`. With automatic
reception, naming synchronization also updates the exactly bound native title
through Codex `thread/name/set`, Grok `_x.ai/session/rename`, or Claude's
append-only `custom-title` metadata. Claude new launches also use `--name`.
Historical names for the same address are removed from existing prefixes on resume;
the bare task title remains separate. Naming errors retry without disabling message
reception. Headless or receiver-disabled launches retain server/Android labels
and model context, without a guarantee of native title synchronization.


## Native memory reminders (cxx 0.9.35)

Managed startup, `sync`, and the content-only cron pass maintain a short MCP
routing reminder at native memory entrypoints. It tells agents to look up fleet
knowledge with `shared_memory_list/search/read`, save it with
`shared_memory_write/append`, and use `project_bootstrap` / `project_memory_*`
for project context. Host-scoped `memory_*` remains scratch.

The API sends `memory_routing: { enabled: boolean, content: string }` in
`POST /sync/bootstrap`, using the same effective per-host, per-engine MCP gate
as managed agent guidance. Agents retrieval metadata also includes that object,
even for a missing canonical document or an unchanged document digest. Missing
configuration disables the reminder; native memory generation/use switches are
never changed. Older servers omitting the field leave existing reminders alone.

The wrapper owns only `<!-- cxx:memory-routing:start -->` through
`<!-- cxx:memory-routing:end -->` and its separator. It prepends or replaces that
block, retaining all other bytes and existing file permissions. Duplicate managed
blocks converge to one; malformed markers, nonregular files and detected
concurrent edits fail the managed sync instead of discarding notes. Writes use
an engine-home lock, temporary file and final re-read before rename; native
writers do not share the lock, so simultaneous writes cannot be fully serialized.
No memory facts are copied to MCP or mirrored from it. Claude can read central memories through MCP tools, while its built-in auto-memory continues using files; the reminder does not replace that native storage backend.

An engine-home `.cxx-memory-routing.json` records touched paths, including custom
Claude locations, so changing a location or disabling MCP can remove old owned
blocks. Failed cleanup retains ownership for retry. Explicit host trust loss
removes reminders; outages retain the last synced content. Removal leaves index
files and local notes in place and removes an otherwise empty owned Grok topic.
The reminder is instruction text, not enforcement: disabled native memory will
not load it, and the existing managed AGENTS.md / CLAUDE.md remains the always-on
routing guidance. Provider memory generation may rewrite an index between syncs;
the next managed sync restores its block.

## Watchdog (wrapper 0.9.36+)

From wrapper 0.9.45, `POST /host/agent-sessions/:id/finish` accepts optional
`watchdog_failure: capacity|crash|hang|user_stop|blocked` alongside `status` and
`summary`. The wrapper retries the same terminal body after an ambiguous response;
the exit classification no longer depends on a separate best-effort activity report.
Both Portal and messaging-only finish paths finalize the currently bound Watchdog
in the same transaction as session termination. A completed ordinary client without
an explicit classification defaults to `user_stop`; a failed client defaults to
`crash`. User stop disables protection and cancels only pending internal recovery;
accepted work remains intact. Worker `peer_delivery` completion stays governed by
its durable work receipt, not its process exit. Address/native-session/current-binding
checks fence delayed old-session receipts. Ordinary Wake/Cron schedules are unchanged.
If no terminal receipt reaches the server, a clean exit remains indistinguishable
from connection loss.

`#watchdog` is a code-managed Skill. Session-scoped `watchdog_get`, `watchdog_enable`,
`watchdog_disable`, `watchdog_finish` live in the wrapper's `cxx-agent` MCP, not the
host MCP. AI can protect only its current task; CLI and Admin can explicitly select
a target. This authority does not enlarge the task. No watchdog is enabled by default.
Recovery of an ended session runs through the host's relay, so it is executed only
on a persistent host; elsewhere it expires unexecuted after its TTL
([host runtime policy](host-runtime-policy.md)).

Enable input: `task_key` (stable per native task, at most 255 UTF-8 bytes), `continuation` (1–30000 UTF-8 bytes),
`duration_seconds` (default 7200), `progress_timeout_seconds` (default 600), optional
current `version`. Durations are integer seconds, 60–604800. Admin/host additionally
require `target: agent:UUID`; scoped tools infer their bound target. Only one live
watchdog per agent. Repeating the same activation returns its original deadline;
changed configuration requires the current version. A terminal task key cannot revive.
Disable: `id`, `version`; finish additionally requires explicit
`status: succeeded|failed|blocked|unknown`. Finish does not replace `agent_task_result`.
Retries of an identical finish/update receipt are idempotent. Continuations are encrypted.

| Surface | Routes |
| --- | --- |
| Admin (messaging read/manage capabilities) | `GET /admin/watchdogs`, `GET /admin/watchdogs/:id`, `POST /admin/watchdogs`, `POST /admin/watchdogs/:id/disable` |
| Signed host operator CLI | `POST /host/watchdogs/get`, `POST /host/watchdogs/enable`, `POST /host/watchdogs/disable` |
| Current bridge only | `POST /host/agent-sessions/:id/agent-messaging/watchdog/get`, `POST /host/agent-sessions/:id/agent-messaging/watchdog/enable`, `POST /host/agent-sessions/:id/agent-messaging/watchdog/disable`, `POST /host/agent-sessions/:id/agent-messaging/watchdog/finish` |
| Wrapper transport | `GET /host/agent-sessions/:id/watchdog/stream`, `POST /host/agent-sessions/:id/watchdog/activity` |

The stream uses SSE `event: watchdog` with an immediate snapshot and a frame every
15 seconds, including when no watchdog is active. Bridge token, session lifetime,
binding generation, native identity, host auth, engine master switches and messaging
policy are checked before opening and before every frame. Each frame carries
`server_time`, `watchdog` (or null), `progress_timeout_seconds`, `terminate_requested`,
`binding_generation`. Watchdog metadata: `id`, `target`, `native_session_id`, `task_key`,
`status`, `version`, `deadline_at`, `last_progress_at`, `last_error`, `last_wake_at`,
`next_wake_at`, `recovery_count`, `recovery_status`, `created_by`. Last wake is the
latest accepted recovery delivery; a queued attempt is not an accepted wake.
No keep-alive generates a model turn or updates progress. Transport backpressure
closes the stream rather than buffering unbounded frames; Fastify shutdown drains it.

Activity reports real output/CPU/tools and classified failure only; heartbeat is not
progress. Failure is `capacity|crash|hang|user_stop|blocked`, with optional native ID
and provider `retry_not_before`. Stale native hooks are ignored. Capacity/crash/hang
create one pending encrypted internal once schedule; recovery starts after 5 minutes
with positive jitter, backs off exponentially through the existing schedule worker,
and observes later provider reset hints. Healthy sessions have no periodic model wakes.
Missing transcripts and permanent provider errors block recovery. Internal schedules
are excluded from ordinary schedule controls. Wrapper capability
`watchdog_protocol_version: 1` is required at activation and recovery claim; durable
acceptance rechecks deadline, status and pinned native identity.

Only the same engine, working directory and native transcript are resumed. A local
kernel writer lock excludes interactive/relay concurrent writers. Supervision signals
only its own child, requires fresh policy immediately before TERM, and protects active
tools and open user questions. After three missing keep-alives (45 seconds), local
termination is suspended, the wrapper reports disconnection and reconnects with bounded
backoff; deadline comparisons use server time. User STOP/off, explicit outcome, lost
eligibility, native identity change or the fixed deadline stops future recovery. Accepted
running work is not killed by expiry/disable. Ambiguous crash recovery can repeat effects.
Admin updates invalidate `watchdogs.changed`; the Portal displays a read-only projection.


## Optional host execution daemon

Hosts opt in under Remote-Sessions; the default is disabled. Linux/systemd is
required. `cxx daemon install|status|start|stop|uninstall|run` manages a separate
`cxx-daemon.service`; its account defaults to root and may be an existing user.
Installation requires root. `cxx update`, wrapper sync/cron and managed
Codex/Claude/Grok launches reconcile an enabled service before native execution;
unprivileged runs report `sudo cxx daemon install` as the pending step only while the
system unit is absent (from cxx 0.9.67; an installed unit stays silent). Accepted
daemon operations and peer deliveries do not reconcile their parent service.
Agent Messaging uses the fleet switch and the current host access policy; the
retired per-host messaging flag is ignored. The account must have usable
managed engine configs and installed provider CLIs. Existing `cxx-agent`
message/auth workers remain separate. No incoming host port is opened.

The daemon authenticates an outbound WebSocket using the existing host key and
uses generation fencing and a private local journal. Starts are durable and
idempotent; losing an acceptance or result response never authorizes a second
execution. After ambiguous process loss the result is unknown, not success.
Eight remote turns may work concurrently by default; additional starts wait
at most ten minutes. Only one turn writes a native transcript at once. Idle
sessions close after 60 minutes, pending questions after 24 hours; host
settings override both. Heartbeats do not count as activity. Explicit resume
requires the same existing native transcript. Automatic recovery is separate.
Authenticated completion records the transcript ID extracted from native headless
output on the bound mailbox and Portal launch, including when the receiver ended
without reporting it. A changed mailbox/native binding rejects completion.

MCP tools: `agent_spawn` takes `host_id`, `engine`, optional absolute `cwd`,
`title`, `prompt`, and stable UUID `client_message_id`. It returns
`operation_id` and logical `session_id`. `agent_spawn_status` reads that session
and its eventual agent address; omit `session_id` to discover enabled hosts and readiness. Use direct messaging for conversation.
`agent_stop` stops only helpers created by the calling agent; operators may
stop any remote session. Stop is cooperative, followed after 30 seconds by
SIGTERM and ten seconds later by SIGKILL to the owned process group. Offline
stops stay pending until the host reports exit. Host disable rejects new work,
drains accepted turns, closes idle sessions and stops the optional daemon.

Hosts show the daemon indicator only when enabled. Green means connected and
ready with capacity; yellow means pending installation, reconnect, partial
engine readiness or full capacity; red means unavailable or blocked. Heartbeats
are sent every 15 seconds, stale at 45 seconds and expired at 90 seconds. Initial
installation gets five minutes before becoming red. Browser disconnection
never leaves a stale green indicator. Tooltip/text exposes reason, last contact
and occupied/max slots. Engine readiness dots retain their separate meaning.

### Daemon HTTP surfaces

Native-control idle polls use a fresh binding snapshot and coalesce their durable
readiness checkpoint to seven seconds. The existing 15-second availability window,
generation fences and locked stop-request/report path are unchanged.

- `GET /admin/host-daemons`, `GET /admin/hosts/:id/daemon` and `PUT /admin/hosts/:id/daemon`: configuration and readiness. PUT accepts `enabled`, optional `resident_enabled`, `username`, `default_cwd`, `max_parallel` (1–64), `idle_minutes` (1–1440), `question_minutes` (1–10080). Omitted `resident_enabled` preserves the stored value; reads and new stores default it to false. Residence requests never enable remote execution. Responses include `residence.requested` and `residence.runtime_enabled`; these describe desired residence and the default-off `CXX_COMMUNICATOR_RUNTIME_ENABLED` rollout switch, not proof of a running service. The switch independently adds signed `orchestrator.communicator_runtime_protocol: 1`. Runtime/service migration acceptance is described in `docs/communicator-resident-runtime.md`.
- `POST /admin/daemon-sessions`: start, using the MCP start fields above. `GET /admin/daemon-sessions/:id` returns status and retained operation results; `POST .../:id/messages` resumes with `prompt` and UUID `client_message_id`; `POST .../:id/stop` requests process termination.
- `GET /host/daemon/config` uses host authentication. `GET /host/daemon/connect` upgrades to WebSocket. Frames contain UUID `id`, `type`, `payload`; replies echo `id` with `result` or `error`. The handshake (`hello`) supplies instance UUID, username, version and ready engines; `heartbeat` accepts optional UUID `active_sessions` (max 64), naming locally running owned processes, and returns current settings and session IDs to stop. `operation` notifications carry offered starts; `accept` must be durably confirmed before execution; `complete` stores an immutable result.
- Per-session MCP routes: the bridge-token authenticated spawn, spawn-status and stop endpoints under `/host/agent-sessions/:sessionId/agent-messaging/` use the existing bridge token and stable agent ownership.
- `host.daemon.changed` invalidates host-daemon and remote-session queries. Configuration/start/stop requests have dedicated audited events.
- Queued starts and resumptions publish `host.daemon.operation.queued` after commit to wake their connected daemon. A 15-second fallback covers missed in-process events and external writers. Empty offer checks read only the operations queue; pending work still performs fresh host authentication and the existing locked daemon/generation/engine admission. Heartbeat and expiry sweeps are unchanged. This wake bus is process-local; another API process relies on the fallback.

### Remote daemon route inventory

- `GET /admin/host-daemons`
- `GET /admin/hosts/:id/daemon`
- `PUT /admin/hosts/:id/daemon`
- `POST /admin/daemon-sessions`
- `GET /admin/daemon-sessions/:id`
- `POST /admin/daemon-sessions/:id/messages`
- `POST /admin/daemon-sessions/:id/stop`
- `GET /host/daemon/config`
- `GET /host/daemon/connect`
- `POST /host/daemon/peer-finished`

See the optional host execution daemon contract in [interface-api.md](interface-api.md).

Remote operation content follows `AGENT_PORTAL_RETENTION_HOURS` once a session is
terminal. Encrypted prompts and replies are cleared; metadata tombstones retain
idempotency keys and daemon ownership so an old request cannot relaunch work or
fall through to an ordinary user relay. Agent Messaging must be enabled globally
and for the host. API shutdown and host/engine access rules still apply.
The default root service needs usable managed configs and provider binaries in
root's environment; choosing an existing user uses that user's home and native
transcripts. No provider login is copied from another Unix account.

On normal completed Portal shutdown, the exact accepted relay delivery retains
its existing, unexpired claim across that session's binding release so the
supervisor can publish buffered output after child exit. This does not reopen the
bridge or extend the lease. A failed/admin-closed session, different delivery
session, expired lease or subsequent native binding cannot use this handoff.
Result retries preserve the same claim and immutable result; ambiguous old work
is not rerun to recover a lost acknowledgement. Daemon replies authenticate the
same `<native-user>:daemon` relay namespace as registration.

- `POST /host/agent-sessions/:sessionId/agent-messaging/spawn`
- `POST /host/agent-sessions/:sessionId/agent-messaging/spawn-status`
- `POST /host/agent-sessions/:sessionId/agent-messaging/stop`

### Fleet Advisor

Any agent can consult a server-hosted senior reviewer when in doubt: to verify a fix, rate a task's
tier, classify a failure or ask a general question. Each advisor is a host daemon session in the
stack's own `advisor` container, so parallelism is that daemon's `max_parallel`, idle close is its
`idle_minutes` (60) and each follow-up is a native resume of the same transcript.

**Not part of the fleet.** The container's host is server-owned: `hosts.internal_role = 'advisor'`,
FQDN `advisor.internal`. On every boot the API ensures it exists (`ops/ensure-advisor-host.ts`):
secure, roaming IPs allowed, no reverse DNS, all engines, never pruned, and a permanent daemon
`{username: advisor, default_cwd: /work, max_parallel: ADVISOR_MAX_PARALLEL (default 8), idle_minutes: 60}`.
It never rotates the key. A v1 install's operator-picked advisor host (`advisor_settings` versions row)
is adopted once and that row deleted. The host is filtered from every admin listing and count
(hosts, overview, topology, agent sessions, host daemons, insecure windows, setup status, engine
counts and destroy progress, messaging admin, Chatty), from fleet session counts, from `agent_list`
and from `agent_spawn_status`. `agent_spawn`, `POST /admin/daemon-sessions` and
`GET|PUT /admin/hosts/:id/daemon` answer 404 for it, and conference invites refuse its addresses.
There is no operator setting: the advisor is available whenever its container's daemon is connected
and Agent Messaging is on.

**Container.** `docker compose --profile advisor` (keep it on every deploy by enabling the `advisor` compose profile in `.env`) runs
`advisor/` as uid 10001, hostname `advisor.internal`, with volumes `advisor_home` and `advisor_work`.
The API writes `{fqdn, api_key, base_url}` to `DATA_ROOT/advisor/bootstrap.json` (0600; `deploy.sh`
and `install.sh` create the directory owned by 10001), which the container mounts read-only at
`/bootstrap`. On each start the entrypoint fetches its signed configs from `/wrapper/v2/config`,
installs cxx from `/wrapper/v2/download` if missing, runs `cxx update` and then `cxx daemon run`
in the foreground. The host's CA bundle (`ADVISOR_CA_BUNDLE`, default
`/etc/ssl/certs/ca-certificates.crt`) is mounted read-only, so a public API behind a private CA verifies.

**Engine and model.** The caller may pass `engine` and/or `model`. Allowed are engines enabled
fleet-wide, assigned to the advisor host and reported ready by its daemon, and for each the
policy-allowed latest models (the managed Model Class Check list). Engines with no policy-allowed model are omitted. If no selectable model remains,
availability is false with reason `advisor_model_unavailable`. The default is the strongest
available model (highest tier, canonical engine order). The model is pinned on the daemon session
(`host_daemon_sessions.model`), sent in the `operation` payload and in relay deliveries
(`target.daemon_model`), and passed as the native `--model` on every turn (cxx ≥ 0.9.99).

- `POST /host/agent-sessions/:sessionId/agent-messaging/advisor/ask` (bridge token, agent identity required): `{question (≤90000), kind verify|tier_check|classify|general (default general), transfer_ids? (≤10), engine?, model?, advisor_session_id?, client_message_id UUID}`. Without `advisor_session_id` it opens an advisor (202, idempotent per caller and `client_message_id`); with it, it queues a follow-up turn. Follow-ups keep the original `kind`, engine and pinned model; use a new `client_message_id` for each question and reuse it on retries. Errors: `advisor_unavailable` (403, with the availability reason), `advisor_model_unavailable` (409, names the allowed engine/model pairs), `advisor_recursion` (403, an advisor session asking), `advisor_busy` (409, no free slot, or the advisor is still answering), `advisor_closed` (409).
- `POST .../advisor/close` `{advisor_session_id}`: the caller's done confirmation; stops the daemon session and records `close_reason: done`. Only the opening agent may close or follow up (403 otherwise).
- `POST .../advisor/status` `{advisor_session_id?}`: one advisor, or the caller's last 20 plus `availability` (`enabled`, `reason`, `engines`, `models[{engine, model, tier}]`, `default`).

Advisor view fields: `advisor_session_id`, `kind`, `status` (`starting|open|closed|failed`, derived from the daemon session when it ended without the advisor row hearing of it), `busy`, `turns`, `advisor_address`, `conversation_id`, `verdict`, `close_reason` (`done|idle|stopped|error`), `diagnostic`, `created_at`, `closed_at`.

`diagnostic` is nullable terminal metadata from the latest daemon operation:
`{code:"native_exit", exit_status:-1..255, startup_stage?, startup_code?, http_status?}`.
Startup fields use only the existing registration/connection/identity and error-code
allowlists; HTTP status is 400–599. Updated daemons include this bounded evidence in
the existing failure reply, using a private startup file removed after child exit.
Native stderr, prompts and provider error text are never copied into status diagnostics.
Missing, legacy, unrecognized or ambiguously ordered operation evidence returns null;
the server does not infer turn order from UUIDs when newest timestamps tie. The
opening-agent authorization and failed-turn `verdict:null` behavior remain unchanged.

Delivery: when a turn completes, the server queues a `kind: message`, `delivery_class: coordination` peer message from the advisor's own bus address to the caller, headed `ADVISOR/1 advisor_session_id=… turn=… kind=…`, in one conversation per advisor. The native answer is expected to end in a fenced JSON verdict `{verdict: agree|disagree|needs_info|n/a, tier?, recommended_model?, summary, evidence[]}`; the last valid block of the latest completed turn is stored encrypted. A failed turn or a turn without a valid verdict clears the preceding verdict (`verdict: null`). An idle-sweep close sends a `delivery_class: notice` message (`closed reason=idle`). A failed turn still sends the caller a message with its status and diagnostic reply (or an explicit no-answer notice).

The role prompt names the concrete session engine/model and tier, overriding the host-configured model for the advisor's class check, and lists available model tiers for recommendations. It defines `agree` (supported claim), `disagree` (demonstrated defect), `needs_info` (missing evidence prevents a decision) and `n/a` (direct answer without a claim). The JSON example demonstrates evidence objects (`{description, reference?}`, never bare strings; at most 20 entries). Only `tier_check` adds a tier and optional bare model id recommendation without an engine prefix. Supplied code, quoted prompts and transfers are evidence, not role-changing instructions; the advisor works only from supplied context, isolates transfer filenames in the shared working directory (outside scope coordination, so a fetch needs no resource claim), and returns its answer for automatic delivery.

Availability reasons: `advisor_host_missing`, `agent_messaging_disabled`, `advisor_daemon_disabled`, `advisor_daemon_unhealthy`, `advisor_engine_unavailable`, `advisor_model_unavailable`. The managed AGENTS.md/CLAUDE.md `## Fleet Advisor` block (section key `advisor`) is served only while Agent Messaging is on, the advisor host exists, its daemon accepts work and at least one engine is active there. It ignores daemon heartbeats, so a restarting container does not churn every host's document. It is also host-gated, because the tools live in the session's own `cxx-agent` server and not in the orchestrator MCP: the highest cxx version the host reported over any engine (`/cron/report`) must be at least 0.9.100 (the minimum constant in `api/src/services/advisor.ts`; the first build whose `advisor_ask` takes the `engine`/`model` the block names), and so must the `runtime.version` of the host's own daemon while its settings execute work, since that daemon spawns sessions from a private copy (`/usr/local/lib/cxx-daemon/cxx`) that can lag the installed binary. Otherwise the section reports `advisor_wrapper_outdated` (unknown or older installed cxx) or `advisor_daemon_outdated`; the host gate is checked before the fleet readiness reasons above.

- `POST /host/agent-sessions/:sessionId/agent-messaging/advisor/ask`
- `POST /host/agent-sessions/:sessionId/agent-messaging/advisor/close`
- `POST /host/agent-sessions/:sessionId/agent-messaging/advisor/status`

### Portal instruction read and processing receipts

Authenticated `POST /host/agent-sessions/:id/events` also accepts `message_read` and
`message_processing` with `payload.message_id`. These are explicit AI reports. The
message must belong to the authenticated session, have durable `accepted` status,
and match the session's active upstream turn. Invalid/missing correlations fail with
`agent_message_not_active` (409) or validation failure. Retries use the original
`client_event_id` and payload, including after a completed turn; a new event cannot
revive old work. No new database fields or transport-generated read receipts exist.
Portal/Admin/Companion timelines carry these events under existing transcript gates.
The UIs correlate them and `assistant_message.message_id` to each outgoing bubble;
uncorrelated replies and receiver keep-alives never advance a message's read status.

## Chatty personal product assistant

Owner/Admin only through always-enforced `chatty.use`; settings require
`chatty.manage`. All endpoints use the current admin cookie and user ownership.
Chat content is encrypted and never broadcast on global admin WS.

| Endpoint | Contract |
| --- | --- |
| `GET /admin/chatty/status` | Visibility, actual provider/engine/model/runner readiness and knowledge digest. |
| `GET /admin/chatty/session` | Current generation, selection, last 100 events, active request; optional before cursor. |
| `PUT /admin/chatty/selection` | engine/model, each nullable; null engine selects automatically. |
| `POST /admin/chatty/messages` | client_message_id UUID, generation, text, optional typed page/entity context; deduplicated durable queue admission. |
| `POST /admin/chatty/runs/:id/answer` | generation and text; resumes the user's pending question. |
| `POST /admin/chatty/runs/:id/cancel` | Stops the user's request; completed changes remain. |
| `POST /admin/chatty/actions/:id/decision` | generation and approve boolean; applies only to the user's current unexpired action. |
| `DELETE /admin/chatty/session` | Deletes content, cancels work and advances the generation across devices; content-free retry tombstones remain. |
| `GET /admin/chatty/events` | Cookie-authenticated personal SSE change notifications; reconnect fetches the canonical snapshot. |
| `GET /admin/chatty/sources/:id` | Authorized read of a source in the build's private knowledge corpus. |
| `GET /admin/chatty/settings` | Installation settings and limits. |
| `PUT /admin/chatty/settings` | enabled, engine_order (all three once), concurrency (1–2), queue_limit (1–100), steps (2–24), timeout_seconds (30–120). |

409 means stale generation, changed action target, expired decision or conflicting
request. 503 means no usable AI access. Queue admission has no success semantics:
only a committed action receipt proves a mutation. Detailed lifecycle, supported
tools, exclusions and rollout requirements: [Chatty](chatty.md).

Route-level Zod validation errors return HTTP 422 with `validation_failed`, including invalid Agent Messaging discovery limits (1–50). They are client argument errors rather than HTTP 500 transport failures.

## Android remote conversations (0.4.10)

See [Android companion](android-companion.md#hosts-and-remote-conversations-0410) for the device-bearer host/start contract and logical Portal conversation projection. Migration 0052 adds `host_daemon_portal_bindings`, `companion_daemon_follows` and encrypted `host_daemon_operations.portal_content_enc`; it preserves existing sessions and permits safe retries. Remote conversations are owned by the paired administrator and retain real Portal events across native launches.

### Daemon working directory

Remote starts use an explicitly supplied `cwd`, then the host daemon's configured
`default_cwd`. When both are empty or omitted, wrapper 0.9.51 resolves the home
of the daemon service user on that host. The systemd service also starts in that
user's home. Explicit paths must remain absolute and exist on the remote host;
an invalid explicit path fails rather than falling back. Registration retains
the resolved native working directory for subsequent resumptions. This applies
to WebUI, companion and agent starts for Codex, Claude and Grok.

### Persistent daemon on insecure hosts

The daemon stays connected outside an insecure access window and reports
`access: {allowed, reason, secure, enabled_until}` separately from transport
health. A connected, locked daemon is yellow (Online · Zugriff gesperrt).
Only status, heartbeat, stop and existing acceptance/result receipts are
allowed outside the window; new starts, offers, acceptance and resume require
an open window. Provider credential distribution retains its existing gate.

WebUI uses the existing host-window activation. Authenticated agents on any
active secure host may use `host_insecure_enable(host_id, duration_minutes?)`
through cxx-agent, for Codex, Claude and Grok alike. Duration defaults to the
target's stored value and is bounded to 0–480 minutes. Source host, agent,
session, target and duration are audited. Insecure callers cannot activate.

A fresh daemon heartbeat renews an already-open window to at least now plus
the stored host duration only for accepted, reported active execution or a
retained native conversation within its idle/question timeout. Queue entries,
unknown transcripts, stale generations and an idle daemon do not renew it.
Heartbeat renewal does not reset session activity or its timeout. Once the
last session ends, the remaining window expires normally. Manual Disable
fences renewal until an explicit enable/approval; accepted work may finish.
Natural fleet-window expiry preserves a later renewed host grant; explicit
fleet closure removes it. No automatic provider session or credential sync is
kept alive merely because the daemon is online.

- `POST /host/agent-sessions/:sessionId/agent-messaging/insecure-enable`: bridge-authenticated secure-source activation; body `{host_id, duration_minutes?}`, result `{host_id, enabled_until, window_minutes}`. Owner mode commits the grant and audit together, rechecking the exact bridge credential, session binding, active secure caller and active target inside the serialized command. New work errors use `daemon_insecure_window_closed`.

## Local session housekeeping

- `GET /admin/session-housekeeping` returns effective fleet rules for Codex, Claude and Grok.
- `POST /admin/session-housekeeping/:engine` saves a complete fleet rule (settings.manage).
- `GET /admin/hosts/:id/session-housekeeping` returns effective rules, fleet values, overrides and last reported run (hosts.read).
- `POST /admin/hosts/:id/session-housekeeping/:engine` saves a complete host rule or `{ "inherit": true }` to reset it (hosts.manage).
- `POST /host/session-housekeeping/inspect` returns the current effective policy and protected native IDs.
- `POST /host/session-housekeeping/reserve` reserves this host/engine with a durable UUID journal token and returns a fresh protection snapshot.
- `POST /host/session-housekeeping/release` releases only the matching token.
- `POST /host/session-housekeeping/report` records bounded counts and bytes without transcripts or paths.

Host requests use the host API key, host/IP policy and engine assignment/master switch. Host maintenance does not extend an insecure interactive window. Rules contain `enabled`, `retention_days` (1–3650), `max_bytes` (1 MiB–1 TiB), and `min_age_days` (1–retention_days). Defaults are enabled, 30 days, 5 GiB and 7 days, separately per engine/local user. Overrides replace the entire rule; disabling preserves its durations. API responses identify source (fleet/host) and return fleet and override values.

Wrapper configs carry the effective rule in optional `session_housekeeping`; absence disables automatic housekeeping for older servers. cxx executes locally, at most daily after a successful pass. Age uses the latest native metadata/artifact modification, retaining all files in parent/subagent bundles together. Age-expired sessions are removed first, then oldest eligible bundles until the session-file budget is met. Index/database sizes are excluded from the selection budget but corresponding rows and physical SQLite space are reclaimed.

Pins, incomplete session metadata, open native goals, queued native work, live sessions and the last native transcript of every known fleet address are protected. This includes paused schedules and later peer/Portal continuations. Protected or young sessions can exceed the budget. An active native process skips its engine; unavailable protection or an unsupported schema prevents deletion. Launch/resume guards and server reservations fence removal; a durable journal quarantines files before deleting associated indexes, then unlinks them. Interrupted operations recover using the same token without retrying native work. Unknown data formats are skipped instead of guessed.

## Planned reboot handoff (protocol 1)

The code-managed `reboot-safe` Skill is listed and retrieved through the ordinary
Skill API at `skill://reboot-safe` for Codex, Claude and Grok. It documents the
existing one-use lifecycle and ownership reconciliation without granting reboot
authority or enabling scope coordination. The Skill ships with the API image.

All three engines advertise `adapter_capabilities.reboot_protocol_version: 1`.
Current bridge tools `agent_reboot` and `agent_reboot_status` map to
`POST /host/agent-sessions/:id/agent-messaging/reboot/prepare`,
`POST /host/agent-sessions/:id/agent-messaging/reboot/arm`,
`POST /host/agent-sessions/:id/agent-messaging/reboot/status`,
`POST /host/agent-sessions/:id/agent-messaging/reboot/restore` and
`POST /host/agent-sessions/:id/agent-messaging/reboot/disarm`.
Prepare accepts `{request_id, boot_id, reason, continuation}`; arm accepts
`{request_id}`; status/restore accept `{}`. Authentication and current native
binding are required. One active reservation per host; UUID/body replay is
idempotent. Watchdog/enabled persistent recovery conflicts return 409.

Host-authenticated `POST /host/reboot-handoffs/ready`, `POST /host/reboot-handoffs/observe`,
`POST /host/reboot-handoffs/disarm` and `POST /host/reboot-handoffs/finish` accepts
`request_id`; ready also requires the new `boot_id`; finish takes `failed` and
optional explicit `task_result`. Normal host, engine and access gates apply.
Readiness polling is bounded locally, never a repeat of native execution.
`POST /host/agent-sessions` accepts `reboot_request_id` and `reboot_boot_id` for an
armed handoff with matching host/user/engine/cwd/native UUID. Its transaction
fences the old launch and transfers original accepted work IDs and claims once.
Duplicate registration must use the same new launch credentials. A second new
launch, same boot, canceled work or expired handoff is rejected.

Codex unattended `exec resume` continuations use the existing headless auth,
quota and approval rules. Codex and piped Claude continuations restore the original
Portal message/status/reply IDs and peer claims through one elected local MCP
receipt owner even without an automatic adapter. That owner neither registers
receiver readiness nor claims or resubmits new work. Headless and piped Claude
launches retain `StopFailure`/`SessionEnd` reporting; channel identity hooks remain
specific to receiver launches.

Active Clients session rows include nullable `reboot` with `request_id`, `state`,
`old_session_id`, `new_session_id`. Planned work is `reboot_hold` until transfer;
it blocks later FIFO delivery and never falls into normal lease-loss redelivery.
Unclaimed handoffs expire after 24 hours. Finished transport without an explicit
work result remains unknown. See [reboot-resume.md](reboot-resume.md).
## System Spawn (new-system provisioning)

Off by default: `versions.host_spawn_enabled`. The operator enables it under
**Settings → Agents → System Spawn**. Only authenticated active VIP
source hosts may use it. New targets are non-VIP; source privilege is never inherited.
The server prepares installation material; the calling agent performs SSH itself.
No SSH credentials are sent to the server and provisioning never starts an agent task.

`host_spawn_prepare({fqdn, engines, secure?, client_message_id, daemon?})` creates
only new hosts. Engines must be a nonempty subset of `codex|claude|grok` and obey
fleet master switches. `secure` defaults to true; false uses the existing initial
30-minute insecure window. Known FQDNs fail without rotation or modification.
A stable UUID and identical normalized input replay the same operation. Different
input with the same UUID conflicts. Host, installer, daemon settings and operation
are committed together; sensitive material is secretbox-encrypted at rest.

Daemon modes: `{mode:"none"}` (default), `{mode:"permanent",username,default_cwd}`,
or `{mode:"timed",username,default_cwd,duration_minutes}` (1–10080 minutes).
The user and absolute working directory must exist on the target. Daemon setup
requires Agent Messaging and Linux/systemd. `setup_script` downloads the existing
one-time installer to a temporary file, checks download success, installs under
the service user, then installs the system daemon as root with that user's signed
config paths. Execute this script over SSH; daemon modes require root.

Response: `operation_id`, `host_id`, `fqdn`, `engines`, `secure`, `daemon`,
`installer` (token, URL, command, expiry), `setup_script` and `setup_steps`.
`host_spawn_status({operation_id})` is scoped to the source host and reports
`state` (`registered|installer_downloaded|installed`; `installer_downloaded` means the launcher passed its preflight and claimed the installer), `installer_used`,
`setup_completed_at`, `daemon_connected`, `daemon_deadline_expired` and
`daemon_expires_at` plus setup material.
`installed` is an authenticated report from the successful target installer;
`daemon_connected` requires a fresh heartbeat. Neither proves a task succeeded.
Start the actual task separately with `agent_spawn`.

To recover a consumed/expired installer use
`host_spawn_status({operation_id,renew_installer:true,client_message_id})` with a
stable renewal UUID. Live unused installers cannot be renewed. Retries replay
the renewal receipt; keys are not rotated. Once renewed, obtain material through
status rather than replaying the original prepare call. After a timed daemon has
expired, the returned setup script repairs the installation and reports the expiry
without reinstalling or reactivating that daemon. The original deadline stays fixed.
Revoked VIP or disabled
feature blocks setup access, including the installer GET and claim before token consumption.
Already installed targets remain intact. Source deletion retains provenance and
blocks installer access; target deletion removes the provisioning record.

Timed daemon lifetime starts at its first successful authenticated connection.
The UTC deadline is stored in daemon settings and locally by wrapper 0.9.53.
Reconnects/reboots do not extend it. At expiry new starts, offers, acceptances and
remote continuation are refused; queued/unaccepted starts are canceled. Accepted
work and durable result receipts drain, then the service exits normally. During
an outage no new work starts; result replay can keep an expired daemon alive until
connectivity returns. Existing idle/question timeout and engine/access policies
still apply. Host registration, installation and auth are not removed.

Admin APIs: `GET /admin/host-spawn/state` (`admin.read`) and
`POST /admin/host-spawn/state` with `{enabled:boolean}` (`settings.manage`).
The target installer reports completion using `POST /host/spawn/setup-complete`
with its own host API key. The callback follows cxx's IPv4-first transport policy
(with a dual-stack fallback) and the installer's TLS policy, preserving the host's
existing source-IP binding. This endpoint remains available for already installed
targets when the spawn switch is turned off. Audit events contain source/target
IDs and operation UUIDs, never installer tokens or host API keys.


## Agent chat: attachments and explicit attention

Existing operator-to-agent chat accepts optional `metadata` with `attachments` (up to ten UUIDs), `reply_to` (a conversation event cursor) and `choice_value` (a stable question choice value). Agent events accept attachments and reply references directly. `waiting_input` supplies `answer_mode: buttons|text|both` plus `choices: [{label,value}]`; legacy `options` remain supported. Buttons send the stable value. The first queued answer wins and exact retries are idempotent.

`severity: important|critical|blocker` plus a stable `notice_id` classifies a message as Needs you.

With cxx 0.9.119, `agent_portal_say` sends ordinary proactive progress or results to the existing operator chat using a stable `client_event_id`, `content` and a one-sentence `summary` (at most 160 characters). It may include `attachments` and `reply_to`; it creates no classified attention and does not finish an inbound instruction. Answer that instruction with `agent_receiver_reply` and its original message ID, normally omitting `severity` and `notice_id`. Use `agent_portal_notify` only for actionable exceptions: important needs attention soon, critical is urgent harm/failure, blocker requires operator action before work can proceed. Routine progress, successful checks and completion reports stay normal. Existing genuine notices still require explicit resolution; no historical notice is silently reclassified.

Ordinary questions do not imply urgency. Unresolved notices remain visible for offline/ended sessions and retain their existing conversation context until explicitly resolved. Opening a chat, answering a question or receiving another reply does not resolve these notices. Resolution names one notice. Push deduplicates per notice and severity; repeated identical notices do not create repeated alarms.

Attachment uploads use a caller-generated UUID, declared filename/MIME/size and optional SHA-256. Create, upload base64 chunks of at most 4 MiB at the returned offset, then seal. Exact chunk retries are accepted; different bytes/metadata under an existing ID are rejected. Only sealed attachments from the authenticated author and same conversation may be attached to an event. Defaults: ten files, 100 MiB/file, 250 MiB/message, 15 minutes/media. Limits endpoints report effective file/message limits. Original bytes and names are preserved; downloads require the conversation's existing authorization and support HTTP byte ranges. Pending uploads expire after 24 hours; linked files follow conversation retention.

- `GET /admin/agent-chat/limits` — Effective upload limits (admin session).
- `GET /companion/v1/agent-chat/limits` — Effective upload limits (paired device).
- `POST /admin/agent-sessions/:id/attachments` — Create/resume upload: {id,name,mime_type,size_bytes,sha256?}.
- `POST /admin/agent-sessions/:id/attachments/:attachmentId/chunks` — Upload {offset,content_b64}; returns persisted uploaded_bytes.
- `POST /admin/agent-sessions/:id/attachments/:attachmentId/seal` — Seal completed bytes after SHA-256 verification.
- `GET /admin/agent-sessions/:id/attachments/:attachmentId` — Return name, MIME, size, SHA-256, upload offset and processing status.
- `GET /admin/agent-sessions/:id/attachments/:attachmentId/content` — Stream original or ?variant=transcript.json|frame-NN.jpg; optional inline=1 for safe media.
- `DELETE /admin/agent-sessions/:id/attachments/:attachmentId` — Discard the authenticated author's unlinked upload.
- `POST /admin/agent-sessions/:id/notices/resolve` — Resolve {notice_id,client_event_id} explicitly; admin/device authorization.
- `POST /companion/v1/agents/:id/attachments` — Create/resume upload: {id,name,mime_type,size_bytes,sha256?}.
- `POST /companion/v1/agents/:id/attachments/:attachmentId/chunks` — Upload {offset,content_b64}; returns persisted uploaded_bytes.
- `POST /companion/v1/agents/:id/attachments/:attachmentId/seal` — Seal completed bytes after SHA-256 verification.
- `GET /companion/v1/agents/:id/attachments/:attachmentId` — Return name, MIME, size, SHA-256, upload offset and processing status.
- `GET /companion/v1/agents/:id/attachments/:attachmentId/content` — Stream original or ?variant=transcript.json|frame-NN.jpg; optional inline=1 for safe media.
- `DELETE /companion/v1/agents/:id/attachments/:attachmentId` — Discard the authenticated author's unlinked upload.
- `POST /companion/v1/agents/:id/notices/resolve` — Resolve {notice_id,client_event_id} explicitly; admin/device authorization.
- `POST /host/agent-sessions/:id/attachments` — Create/resume upload: {id,name,mime_type,size_bytes,sha256?}.
- `POST /host/agent-sessions/:id/attachments/:attachmentId/chunks` — Upload {offset,content_b64}; returns persisted uploaded_bytes.
- `POST /host/agent-sessions/:id/attachments/:attachmentId/seal` — Seal completed bytes after SHA-256 verification.
- `POST /host/agent-sessions/:id/attachments/get` — Host bridge chunk download: {attachment_id,variant?,offset?}; base64 bytes, next_offset, done.

Audio and video preparation runs locally in the isolated `media-worker` service with no network. The baked Whisper small model produces timestamped transcript JSON; video also produces up to twenty timestamped JPEG frames. Preparation failure leaves the original downloadable. Host bridge routes require the scoped bridge token, while admin and companion routes enforce transcript/manage capabilities even under compatible authorization.

## Audit corrections: host lifecycle and quota observations

Installer generation completes before the single-use token is consumed. A build
failure remains retryable; an invalid mint request preserves existing tokens,
and successful replacement is transactional. Engine reassignment, API-key
rotation and host deletion revoke old installers. Redemption checks the current
assignment, status and temporary expiry. A delivered installer remains single
use after client SIGKILL; abandoned unprovisioned hosts are reclaimed by lifecycle
cleanup, and a new installer can be minted.

Temporary-host credentials expire after two hours without authenticated contact.
Contact renewal and cleanup recheck the same locked host row. Inactivity policy
zero disables only inactivity pruning; expired and never-provisioned records
still expire. Cleanup runs on successful host requests, registration and admin
host listing. All engines and pooled-account provisioning count.

A failed quota refresh preserves the last measured usable observation, its true
`fetched_at`, percentages and provider gates. `refresh_error`,
`refresh_attempted_at` and `cached` disclose the failed refresh; history retains
the failed attempt and its retry cooldown. With no usable observation, quota is
unavailable. The usage worker cancels and drains its active refresh before closing
the database. Existing wrapper age limits still apply to cached observations.

With `quota_week_partition` set to 5 or 7, Codex uses `daily_used_percent` and
`daily_baseline_at`: the nonnegative weekly usage delta from the first usable
UTC-day observation for the same account. Weekly windows may occupy either
provider slot. A day with no usable baseline remains unknown. The daily allowance
is `100 / partition` percent of the weekly budget; the wrapper applies the same
warn/deny threshold, advisory mode and VIP policy as other quota rows. It does not
carry a previous UTC day's reading into the current daily gate.

### Native conversation activity (migration 0060, cxx 0.9.60)

Receiver registration negotiates `capabilities.activity_v1` when Portal is enabled and
returns the current numeric `binding_generation`. Capabilities remain fixed for that
receiver generation, including registration retries. Older wrappers ignore these fields;
new wrappers do not send activity to servers that omit the capability.

`POST /host/agent-sessions/{id}/activity` uses the existing `X-Agent-Bridge-Token`.
Body: `generation` (receiver UUID), `binding_generation`, `native_session_id`,
`sequence` (positive safe integer increasing per receiver generation),
`state` (`working|idle|waiting|unknown`), `wait_reason` (`approval|input` for waiting,
otherwise null), `source` (`codex-thread|claude-hooks|grok-session`), and
`evidence_age_ms` (0..86400000), and optional `receiver_bound` (boolean). Only the
current bound engine, native session and fresh receiver may report. Stale ownership returns 409; duplicate or older sequence
numbers return `{accepted:false}` without refreshing evidence. Successful writes
return `{accepted:true}`. This endpoint does not renew liveness, mark work complete,
change portal turn ownership, or act as watchdog progress.

Session list/companion responses add `activity: {state, wait_reason, source,
changed_at, expires_at, reason}`. The latest observation is durable JSON on
`agent_sessions.activity`; expiry is server receipt time plus 45 seconds minus
reported evidence age. A `receiver_bound` observation (cxx 0.9.121+, which reports
changes only) instead stays current while the same receiver generation is fresh, and
its `expires_at` is that receiver's heartbeat plus 45 seconds. Receiver failure, changed native binding and expired evidence
project Unknown. A still-open portal question supplies a `portal-question` input
wait when native state is Idle/Unknown; fresh Working takes precedence. Activity
transitions publish `agent_portal.sessions.changed`, without transcript events or
push notifications. Clients age evidence locally using the snapshot server clock.
Companion reconciliation includes observation expiry so refreshed evidence reaches
phones even when the native activity state stays unchanged.
Existing `presence`, `relay_ready`, `active_turn_id` and work receipts retain their
contracts. Offline/Ended take precedence visually; activity never grants send access.

Roll out the additive API/migration before wrapper and UI updates. Older wrappers
appear with Unknown activity; an older server retains the clients' legacy display.
Rollback can restore older wrappers/clients/API while retaining the nullable column.

## Orchestrator Feedback

With Skills enabled, managed Skills guidance automatically invokes the shared stored
`fleet-reflect` Skill once before each final work response or managed work-result
delivery, including failed or blocked work. Progress messages, acknowledgements and
result retries do not repeat the review. Codex and MCP-enabled Claude load it through MCP;
Claude without usable MCP and Grok use their native synced Skill files. The Skill reviews observed orchestrator/tool
experience, searches reports across statuses, appends materially new evidence or
submits an actionable bug, feature or usability report. No finding means no report
or extra final-response paragraph. Disabled/unavailable feedback leaves useful
findings pending without bypassing the setting or delaying the original result;
reflection does not authorize fixes or deployments. The manifest is published via
`skill_store` (review copy: `docs/skills/fleet-reflect.SKILL.md`); the automatic trigger
requires the API change and the host's next instructions sync. This is agent guidance,
not a runtime completion hook or a background schedule.

The independent central inbox provides `feedback_submit`, `feedback_list`, `feedback_get`, `feedback_claim` and `feedback_update` across Codex, Claude and Grok. The fleet switch `feedback_enabled` defaults off, hides tools during discovery and blocks calls while disabled. Enable it under Feedback in the WebUI (`/admin/feedback/state`); managed AGENTS.md/CLAUDE.md/Grok AGENTS.md dynamically gain the workflow on the next sync only when usable managed MCP configuration exists. Disabling removes that section on sync without changing canonical authored rules or deleting reports.

Claims are exclusive, token-fenced and renewable for 30 minutes. Updates check the item version and append history. Resolved requires a fix reference and verification evidence; deployment is recorded separately. Host/engine attribution is authenticated; optional agent UUIDs are descriptive. Admin routes use `feedback.read`/`feedback.manage`. No agent is started and no merge or deployment is implied. See [MCP workflow](MCP.md#orchestrator-feedback-workflow) for request/response contracts.

### Feedback admin endpoints

- `GET /admin/feedback/configuration` — feedback mode, explicit runner engine/model, automatic-publication opt-in, revision and token presence; never token material.
- `POST /admin/feedback/configuration` — `{expected_revision, config:{mode,auto_publish,runner_enabled,engine,model}, token?, disconnect?}`. Revision-checked, audited settings; a supplied classic GitHub PAT is secretbox-encrypted. Existing installations retain `source_developer`; fresh baselines select `user`. Outbound reporting and runner use remain opt-in.
- `POST /admin/feedback/preflight` — `{title,component?}`; reads baked build identity and searches open/closed upstream issues. Does not publish or pass the gate.
- `POST /admin/feedback/:id/recheck` — `{expected_version}` queues a User-mode review of this local report, or reconciliation of an uncertain publication. Old developer reports require this explicit selection before entering the pipeline.
- `GET /admin/feedback/state` — activation state (default off).
- `GET /admin/feedback/summary` — `{open, in_progress, blocked}` counts for the console's top-bar indicator; expired claims are released first.
- `POST /admin/feedback/state` — set `{enabled:boolean}`; dynamic agent guidance follows on sync.
- `GET /admin/feedback` — filtered, paginated inbox; HTML navigation serves the SPA.
- `POST /admin/feedback` — idempotent report submission.
- `GET /admin/feedback/:id` — original report, current claim/outcome and history.
- `POST /admin/feedback/:id` — version-checked triage/comment/outcome update.
- `POST /admin/feedback/:id/claim` — acquire/renew/release; administrative force_release requires reason.
- `DELETE /admin/feedback/:id` — hard-deletes one **closed** item (`resolved|dismissed|duplicate`) and its whole event history. `open`, `in_progress` and `blocked` items, and any item still holding a live claim, return `409 feedback_not_closed`; an unknown or already deleted ID returns `404`.
- `POST /admin/feedback/purge` — bulk delete: body `{statuses:[...closed statuses], older_than?: RFC3339}` (strict; any open status is `422`). `older_than` is compared against `updated_at`, i.e. when the item last changed (normally its closure), not `created_at`.

Both deletes return `{deleted, events, cascaded_duplicates, by_status, ids}`. **Duplicates of a deleted item are deleted with it** (they are always closed, and keeping them with `duplicate_of: null` would break the rule that a `duplicate` names its canonical); they are counted in `cascaded_duplicates`. Items, events and the audit row commit in one transaction: an `admin_events` row `feedback.deleted` / `feedback.purged` records the admin user, criteria, counts and each removed item's id/title/status. The inbox is invalidated through the existing `feedback.changed` WebSocket event. There is no restore path and no MCP tool for this — agents cannot delete feedback; take a `mysqldump` of `feedback_items`/`feedback_events` first if you may need the history. Chatty excludes both routes.

Reads require `feedback.read`; writes require `feedback.manage`. Fields and lifecycle are documented in [MCP.md](MCP.md#orchestrator-feedback-workflow).


## Shared CoCo communicator (cxx 0.9.72)

The optional signed `orchestrator.communicator_protocol: 1` capability routes managed
CoCo traffic through a per-user Unix socket and one multiplexed server WebSocket.
Provider traffic, session identities and account/refresh ownership retain their existing
contracts. See [communicator protocol, lifecycle and rollout](communicator.md).

### Live topology endpoints

Native process controls (cxx 0.9.85):

- `POST /host/native-control/receipt` replays a durable local native-stop receipt using the host API credential. Communicator support and the connection owner must be enabled. The strict body is `{session_id:<uuid>, binding_generation:<nonnegative integer>, native_instance_id:<uuid>, request_id:<uuid>, result:"accepted"|"exited"|"refused"}`. The server revalidates host policy/fingerprint plus the exact session, native instance, binding and existing stop request. It may record an already-ended session's known exit; it never repeats a stop or starts a process. Successful and duplicate receipts return `{recorded:true}`; a delayed `accepted` after `exited` is acknowledged, contradictory outcomes or replaced identities are fenced. The wrapper retains its fsynced receipt journal until this durable acknowledgement, then removes the entry.
- `POST /host/agent-sessions/{id}/native-control` uses the session bridge credential and body `{protocol:1, instance_id:<uuid>, report?:{request_id:<uuid>, status:"accepted"|"exited"|"refused"}}`. From cxx 0.9.121 the owning wrapper polls every ten seconds only after starting its child (older wrappers use three seconds). Registration pins the process instance and current binding generation. Timestamp-only checkpoints recheck the live session/address binding, ready status and absent request in the conditional write; a racing change enters the locked path. A replacement binding is refused. `exited` is sent only after the wrapper observes Wait complete; an accepted request is not an exit receipt. Legacy servers return 404 and the wrapper stops capability polling.
- `POST /admin/agent-sessions/{id}/stop` requires `agent_portal.manage`, enabled portal/engine and body `{client_message_id:<uuid>, expect:{instance_id:<uuid>, binding_generation:<integer>}}`. A fresh capability is required (15 seconds); otherwise 404/409. Concurrent identical requests share one durable request; a changed key or actor cannot supersede it. The bound watchdog is disabled, and recovery for the current scheduled execution is canceled. Future ordinary schedule ticks remain configured. Audited as `agent_session.native_stop`.
- `GET /admin/agent-sessions/{id}/stop` requires `agent_portal.read`; returns the retained control view or null. Fields: `instance_id`, `binding_generation`, `request_id`, `available`, `updated_at`, and `status` (`ready`, `requested`, `accepted`, `exited`, `refused`, or derived `unknown`). A pending receipt older than 15 seconds is unknown; a delayed matching exit receipt can settle it. Receipts survive session completion until session retention removes the row.
- `GET /admin/topology` adds nullable `agents[].native_control` with that view. It is independent of communicator parentage. Daemon launches retain their existing daemon stop contract; the native endpoint refuses them with `409 native_stop_daemon_managed`. Other managed launches use native stop when available; record-only close remains separate.

- `GET /admin/topology`: requires `hosts.read`; one snapshot of the live connection tree: the server (root), the communicator sockets connected to this API process, and the live agent sessions. A session's `association.parent_id` names a communicator only with `basis: "session_traffic"`, meaning the API answered a request for that session over that socket within the presence window (`attributed`; older is `stale`). Anything else is `unattributed` and hangs off the server — host, user and engine are never used to guess a parent. Sessions are omitted for a role without `agent_portal.read`.
- `POST /admin/communicators/{id}/disconnect`: requires `agent_portal.manage`; body `{client_message_id (uuid), expect?: {host_id, username}, note?}`. Closes that one communicator socket (close code 4001) and answers `{outcome: "closed"|"requested", reconnect_expected: true, affected: {agent_ids, leases_reported}}`. It does not stop the communicator process: the owner redials within 1-30 s. `404 communicator_not_connected` means it is already gone; `409 communicator_target_changed` means the selection no longer matches. A repeat with the same `client_message_id` replays the first answer. Audited as `communicator.disconnected`.
- `POST /admin/communicators/{id}/terminate`: requires `agent_portal.manage`; same body as disconnect. Asks the communicator owner *process* to stop, addressing the command to the `instance_id` that owner announced, and only for an owner that announced the capability and that identity (`409 communicator_terminate_unsupported` otherwise; `409 communicator_terminate_in_progress` while another stop for the same connection is running, and for 15 s after the owner accepted one, so a second key cannot send a second command to an owner that is draining). Answers what was observed, never what was sent and never a process exit, which the server cannot see: `acknowledged_closed` (the addressed process acknowledged, then its connection closed), `acknowledged` (acknowledged, connection still open when the wait ended), `refused` (declined, or acknowledged by a different process), or `unacknowledged` (nothing answered within 5 s; the connection is left alone). `process.pid` is the owner's own report. A `client_message_id` is reserved before the first await, so concurrent duplicate clicks dispatch once and share the outcome (`replayed: true`); a reserved key is never evicted while its operation is running, whatever else is in flight. Native sessions are not signalled; a surviving client starts a new owner on its next managed call. Audited as `communicator.terminated` (including `owner_instance_id`).

The cxx 0.9.80 resident-runtime integration adds nullable `communicators[].resident`
to `GET /admin/topology`: `owner_instance_id`, `sequence`, `runtime_protocol:1`,
`mode:"on_demand"|"resident"`, `managed`, `resident_enabled`, `execution_enabled`,
`binary_sha256`, `draining`, `local_requests`, `legacy_clients`, and nullable
`execution:{running,fenced,verified,workload:{accepted,peer_claims,children,receipts,writes,requests,legacy_clients}}`.
The server adds `received_at`, `age_s`, and `stale` (older than 45 seconds).
These are self-reported diagnostics, never admission or process-exit evidence.

The server advertises `resident_runtime` in `ready.control`; a signed-runtime
owner sends a strict `resident_status` frame with those report fields only after
negotiated `owner_identity` capabilities. Counters are integers from 0 to
1,000,000, sequences are positive safe integers, and executable hashes are
64 lowercase hexadecimal characters. Invalid/unknown diagnostic fields and
missing/mismatched process identity are ignored without publishing or closing
the shared control connection. Diagnostics add no separate authorization read:
existing heartbeats recheck host authorization every 15 seconds and close a
revoked connection with 1008. Late/duplicate sequences leave the newest report untouched. Every report
belongs to one connection and one instance; disconnect or identity change
clears it. Old owners continue sending their existing frames unchanged.

### Communicator transport endpoints

Every frame reauthorizes against a fresh host/API-switch/reverse-DNS-policy
snapshot. SQL plans reuse construction only; no credential or permission result
is retained between frames. The 15-second connection recheck remains active.

- `GET /host/communicator/connect`: host-key/IP-authenticated WebSocket protocol 1, enabled by the signed communicator capability. Multiplexes existing host routes, MCP and daemon frames with UUID-correlated replies and content invalidations. A rejected request frame (disallowed path, including a trailing-slash variant, or invalid fields) receives `{id, status: 400}` with code `communicator_invalid_request`. The one exception is a `GET` of a canonical bakery URL (`/wrapper/v2/bin/{artifact}/{os-arch}/v{version}/{binary}`, no query): it receives `{id, status: 307, headers: {location: "../../../../download/{artifact}/{os-arch}/v{version}/{binary}"}, body: ""}` without dispatch, so cxx 0.9.71–0.9.74 owners — which send that self-update download as a control frame and have no fallback — follow it to `/wrapper/v2/download/...` over direct HTTPS. Any other method or form of that path still gets 400. Failed host authorization closes the socket with 1008. A reply above 11 MiB leaves the connection open: known reads receive `{id, status: 502}` with code `communicator_response_too_large`, while completed operations that cannot safely be repeated receive `{id, status: 409}` with code `communicator_outcome_unknown`. Bootstrap qualifies as a read only with explicit `include_auth:false` and no auth candidate or session admission. `host.*` invalidations that carry a numeric `id` or `host_id` reach only that host's connection. With `CXX_COMMUNICATOR_UPDATE_ENABLED`, `ready.control` adds `wrapper_update`, and the server sends payload-free `{type:"update_available"}` on `version.*`, `settings.changed` and this host's `host.updated`. Owners take the target only from `/cron/check` together with their signed config (see `docs/communicator.md`). Transport + sync add signed cache protocol 1 for older callers and protocol 2 for cxx >=0.9.122 (no separate cache switch); `CXX_COMMUNICATOR_UPDATE_ENABLED` adds `orchestrator.communicator_update_protocol: 1` (requires transport).
- `GET /admin/communicators`: requires `hosts.read`; reports the API process's live communicator connections, users, versions, client counts and last sync.

See [CoCo Communicator](communicator.md) for the local socket, reconnect and rollout contract.

From cxx 0.9.74, communicator HTTPS transfers use the signed host key and remove
cookies and forwarding headers. Large `POST /mcp` requests additionally carry
`X-Cxx-Communicator: 1`: their bearer must resolve to the accompanying host key's
host and cannot grant operator capability; mismatches return HTTP 401 with
`communicator_mcp_host_mismatch`. Ordinary MCP credential resolution is unchanged.


### Communicator sync ownership

From cxx 0.9.73, signed `orchestrator.communicator_sync_protocol: 1` enables
central scheduling of finite startup/content operations and active-session auth
convergence. Enable `CXX_COMMUNICATOR_SYNC_ENABLED` alongside the existing transport
flag. Native login, account assignment, refresh ownership and session lifetimes
retain their engine-specific contracts. Broad session-lifetime sync pauses are
replaced by short native-home fences; local credential changes and server auth
invalidations converge through the existing validated writers. Local materialization
is reported separately from native adoption. Signed rollback drains auth work and
hands polling back to the existing wrapper without restarting the native CLI.
See [Communicator ownership and rollout](communicator.md#central-sync-ownership-cxx-0973).

Host-authenticated `POST /host/daemon/migration` accepts `{request_id: UUID, command: "fence"|"status"|"release"}`. It preserves requested enablement and queued/accepted work, holds admission for that UUID, and returns `fenced`, `ready`, `running`, `accepted` and `peer_claims`. Readiness requires all three counts to be zero. Local work/receipt checks and actual process-exit proof are additionally required before service replacement. Another UUID cannot release the fence. While fenced, host daemon config/heartbeat project effective execution enablement false; config also reports `execution_requested` independently so the resident owner remains available for migration.


## Fleet model policy

- `GET /admin/model-policy/:engine` (`settings.read`) returns
  `{engine, latest_only, latest_models, replacements, disabled_models?}` for
  `codex|claude|grok`. `replacements` maps each supported model to the newest
  version of its family, including identity entries.
- `PUT /admin/model-policy/:engine` (`settings.manage`) accepts only
  `{latest_only: boolean}`. Defaults off, stored under
  `<engine>_models_latest_only` in `versions`; no migration is needed. Changes
  emit `settings.changed` and audit `admin.model_policy` with engine and flag.
  Invalid engines/bodies return 422.
- Enabled policy filters model-defaults catalogs and returns effective model
  and effort. Optional `stored_model` names an older saved selection when its
  successor differs. Writes and toggles preserve stored preferences.
- Gateway catalogs expose current enabled versions per family. Inference
  resolves known old IDs to their successor before checking manual disables.
  This follows the answering backend across surfaces and API-key assignments;
  response model IDs name the model used. Unknown IDs remain errors, with no
  older-generation fallback. Existing legacy aliases and cross-surface
  native-family compatibility retain their normal canonical resolution.
- Signed configs carry the same policy for cxx >= 0.9.94. It takes effect at
  configuration sync for new managed starts; running sessions and direct
  provider binaries remain unchanged. Offline starts use the last signed rule.


## Session scope coordination (protocol 1)

See [Session scopes, rooms and resource claims](agent-coordination.md) for the
automatic host/project check-in, room APIs, claim lifecycle, engine parity, grouped
agent graph, migration 0078 and rollout/rollback contract. cxx 0.9.103 introduces
`agent_context_get/update`, `agent_room_list/read/send`, and
`resource_claim_acquire/status/release` on the session-bound cxx-agent MCP server.
The feature starts disabled and never grants permission for the reserved action.
Server-owned advisor sessions are outside it: no registration `scope_context`,
`agent_context_get` → `enabled:false, reason:"internal_host"`, and claim/room
mutations → 403 `agent_coordination_not_applicable`.
Routine scope presence and claim updates remain in room history and current membership,
with normal cursors and WebSocket invalidation, but do not queue model wakeups.
Mixed scope batches fan out only room chat; direct resource-conflict notices
retain their delivery contract for all three engines. Before presentation, bounded
queue scans retire provably routine, never-attempted server backlog, including
safe routine-only digests. Work, chat, critical alerts, current or ambiguously
bound lease waiters, malformed payloads and accepted/uncertain deliveries are kept.


### Agent role endpoints

Contract: [agent-roles.md](agent-roles.md). Module switch `roles_enabled` (default off). Admin reads need `content.read`, writes `content.manage`; every write is audited as `agent_roles.*`.

- `GET /admin/roles/state` — module switch `{enabled}`.
- `POST /admin/roles/state` — set `{enabled:boolean}`; the `roles` Skill and the Agent Roles guidance follow on sync.
- `GET /admin/roles` — roles with current version, policy, holder and open-proposal counts.
- `POST /admin/roles` — create `{slug, display_name, summary, policy?}`; `state` and `proposals` are reserved slugs.
- `GET /admin/roles/:slug` — role, published versions, draft and active holders.
- `PATCH /admin/roles/:slug` — `display_name`, `summary`, `status`, `policy` with `expected_version`.
- `GET /admin/roles/:slug/timeline` — versions and proposals with gates, judge and reviews.
- `GET /admin/roles/:slug/versions/:version` — one version's manifest and text files.
- `PUT /admin/roles/:slug/draft` — save the operator draft `{manifest, files, changelog?}`.
- `DELETE /admin/roles/:slug/draft` — discard the draft.
- `POST /admin/roles/:slug/publish` — publish the draft as the next immutable version; holders discover it through `agent_role_current` or role reads.
- `POST /admin/roles/:slug/revert` — `{version, reason}` publishes a new version carrying an earlier one.
- `POST /admin/roles/:slug/versions/:version/withdraw` — `{reason}` blocks new activations of a faulty version.
- `GET /admin/roles/proposals/:id` — proposal with current and proposed bodies and its event trail.
- `POST /admin/roles/proposals/:id/decide` — `{verdict: accept|reject, reason, expected_version}`; reject on an applied proposal vetoes it by reverting.
- `POST /host/agent-sessions/:id/agent-messaging/roles/activate` — `agent_role_activate`; see [agent-roles.md](agent-roles.md).
- `POST /host/agent-sessions/:id/agent-messaging/roles/current` — `agent_role_current`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/release` — `agent_role_release`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/propose` — `agent_role_propose`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/proposals` — `agent_role_proposals`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/review` — `agent_role_review`.

Routine role version updates and proposal outcomes are pull-only through
`agent_role_current`, `agent_role_proposals`, role resources and the audit/timeline.
They do not queue automatic `ROLE-UPDATE/1` or `ROLE-PROPOSAL/1` information for
resumable addresses. Explicit `ROLE-REVIEW/1` requests remain delivered. Faulty-role
withdrawals retain a `ROLE-UPDATE/1 severity=withdrawn` alert, bound to the current
live session and binding as a coordination notice; ended or replaced holders do
not inherit it. User publications retain their normal delivery semantics.

### Scope coordination endpoints

- `POST /host/agent-sessions/:id/agent-messaging/context/get` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/context/update` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/rooms/list` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/rooms/read` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/rooms/send` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/claims/acquire` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/claims/status` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/claims/release` — see [coordination contract](agent-coordination.md).
- `GET /admin/agent-messaging/scopes/state` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/state` — see [coordination contract](agent-coordination.md).
- `GET /admin/agent-messaging/scopes` — see [coordination contract](agent-coordination.md).
- `GET /admin/agent-messaging/scopes/:scopeId/members` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/read` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/send` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/resolve` — see [coordination contract](agent-coordination.md).

### Agents page navigation

Browser GET/HEAD navigation accepting `text/html` at `/admin/agents`, including
`?view=graph`, serves the SPA shell. Requests accepting `application/json` retain
the authenticated legacy agents-document API. The shell performs its normal
session check; navigation does not grant access to admin API data.

## Shared conversations

Shared room APIs use existing agent-messaging read/manage/reveal-content capabilities. Content reads and mutations are audited without plaintext.

- `GET /admin/agent-messaging/chats`
- `POST /admin/agent-messaging/chats/read`
- `POST /admin/agent-messaging/chats/seen`
- `POST /admin/agent-messaging/chats/send`
- `POST /admin/agent-messaging/chats/create`
- `POST /admin/agent-messaging/chats/manage`
- `POST /host/agent-sessions/:id/agent-messaging/chats/list`
- `POST /host/agent-sessions/:id/agent-messaging/chats/read`
- `POST /host/agent-sessions/:id/agent-messaging/chats/send`
- `POST /admin/agent-messaging/chats/:roomId/attachments`
- `POST /admin/agent-messaging/chats/:roomId/attachments/:attachmentId/chunks`
- `POST /admin/agent-messaging/chats/:roomId/attachments/:attachmentId/seal`
- `GET /admin/agent-messaging/chats/:roomId/attachments/:attachmentId`
- `GET /admin/agent-messaging/chats/:roomId/attachments/:attachmentId/content`
- `DELETE /admin/agent-messaging/chats/:roomId/attachments/:attachmentId`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/:attachmentId/chunks`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/:attachmentId/seal`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/get`

Create accepts client_request_id, kind (group/conference), title, description, members (address UUIDs) and duration_minutes (5–360; default 60). Read accepts room_id, optional opaque before cursor and limit (1–100). Send accepts room_id, client_request_id, content, attachments, optional reply_to event UUID, recipients (address UUIDs) or ask_all. Agents may post contributions but cannot request a new answer round. Seen accepts room_id and through (timestamp). Manage accepts room_id, client_request_id, action (invite/remove/close) and address_id for membership changes. Retries retain the exact payload and UUID. Operator conference ownership is an admin identity, not a fabricated native session.

Room directories on web, companion and agent bridges accept `view: active|history|all` (query parameter on GET; body field on bridge list), defaulting to `active`. History contains adjourned conferences once every retained roster member is offline, including resumable sessions; Active omits them. Presence uses the configured heartbeat freshness window and includes members already marked left. Expired open conferences use their effective adjourned state; open and adjourning rooms otherwise remain active. Filtering happens before pagination. This is read-only directory cleanup: conference records, messages and audited history reads remain available in History, the conference inspector and room read APIs.

### Model catalog policy

`GET /admin/model-policy/:engine` reads the engine's catalog filtering policy. `PUT /admin/model-policy/:engine` accepts only `{ "latest_only": boolean }`, records the setting and returns the effective policy. Both routes require an admin session; capability enforcement follows the route inventory. Engines are `codex`, `claude` and `grok`.

### Companion shared rooms (Android 0.5.0)

Native device bearer authentication only; cookie credentials and browser-origin
requests are rejected. Existing API-disable and device-revocation gates apply.
All results use the standard envelope and `Cache-Control: no-store`.

- `GET /companion/v1/rooms` — `agent_messaging.read`; `offset` pagination, returning `rooms`, `has_more`, `next_offset` and `enabled`.
- `GET /companion/v1/rooms/candidates` — `agent_messaging.manage`; existing safe address inventory for participant selection.
- `POST /companion/v1/rooms/read` — `agent_messaging.reveal_content`; `{room_id,before?,limit?}` returns `{room,events,next_before}`. Reads are audited without message bodies.
- `POST /companion/v1/rooms/seen` — `agent_messaging.reveal_content`; `{room_id,through}` advances the existing monotonic operator read timestamp, clamped to server time.
- `POST /companion/v1/rooms/send` — `agent_messaging.manage` and `agent_messaging.reveal_content`; the shared room send contract (`room_id`, `client_request_id`, `content`, optional attachment IDs, `reply_to`, `recipients` or `ask_all`). Uses the paired operator identity and existing idempotency/delivery semantics.
- `POST /companion/v1/rooms/create` — the same two capabilities; shared group/conference creation contract and stable `client_request_id`.
- `POST /companion/v1/rooms/manage` — the same two capabilities; shared invite/remove/close contract. The server rechecks conference ownership/state and membership.
- `POST /companion/v1/rooms/:roomId/attachments` — both room capabilities; create an upload with `{id,name,mime_type,size_bytes,sha256}`.
- `POST /companion/v1/rooms/:roomId/attachments/:attachmentId/chunks` — both room capabilities; append `{offset,content_b64}` using the existing upload bounds.
- `POST /companion/v1/rooms/:roomId/attachments/:attachmentId/seal` — both room capabilities; finalize the verified upload.
- `GET /companion/v1/rooms/:roomId/attachments/:attachmentId` — reveal-content capability; room-access and unpublished-draft ownership checks precede metadata access.
- `GET /companion/v1/rooms/:roomId/attachments/:attachmentId/content` — same read gates; download with the existing variant and digest contract.
- `DELETE /companion/v1/rooms/:roomId/attachments/:attachmentId` — both room capabilities; discard only the author's eligible draft upload.

The foreground Companion socket adds the `rooms` invalidation scope, delivered
only with `agent_messaging.read`. It never sends room IDs, message bodies or
attachments. Existing clients ignore the additional scope. Android reads the
canonical room history after invalidation; no new database migration or room
push subscription is introduced.

### Host connection evidence and server history retention

`GET /admin/hosts` and `GET /admin/hosts/{id}/detail` add `presence` (`online|offline`),
`presence_heartbeat_at`, `presence_observed_at`, `presence_fresh_seconds` (45), and
`last_contact_at`. Online requires a fresh bound agent heartbeat or connected communicator.
Permanent-host authentication checkpoints `last_contact_at` at 30-second intervals;
it is approximate contact history, not a per-request ledger. Current credentials,
status and expiry are checked on every contact. Temporary-host sliding expiry still
renews on every valid contact under the host lock.
Optional contact bookkeeping reuses the same request's fresh authenticated host
snapshot; checkpoints that write still revalidate the current row under lock.
Owner-mode empty peer/portal claims use the current RAM snapshot for admission,
receiver ownership and queue absence, without SQL. Permissions, settings and queue
state are authoritative owner state updated by durable commands, not TTL-cached
query results. Nonempty claims use serialized durable owner commands. The legacy
path uses a fresh SQL snapshot and caches only compiled SQL.
It is independent of provider authentication readiness. Administrative edits and provider
refreshes never update `last_contact_at`; legacy timestamps remain for compatibility.
Host inactivity pruning uses genuine contact, falling back to creation when unknown. An
explicit key rotation grants 30 minutes for provisioning; ordinary edits grant no extension.

In owner mode, indexed deadlines schedule bounded retention work. The legacy
portal retention worker runs every `AGENT_PORTAL_PURGE_INTERVAL_SECONDS` (300 by default),
including when messaging is disabled or the source host never reconnects. It purges expired
MCP/admin credentials and legacy timed provider-account reservations at their existing expiry and inactive server conversation history after
24 hours: peer threads/messages/results, ended portal sessions (including rebooted sessions),
remote/daemon/Advisor history, Chatty, shared room history, unused agent addresses and expired dormant relays.
Persistent group/project/scope definitions remain. Native transcript housekeeping is separate.
Explicit schedules (including paused), active watchdogs/reboot handoffs and unfinished work
protect their required targets. Legacy timed stale delivery leases become unknown/ambiguous, never success
or replay. Connection-owned uncertain grants are not purged merely for elapsed time. Historical data and reads alone do not protect identities. Old unresolved notices
cannot retain an expired session indefinitely. Cleanup is bounded and transactional; large
threads drain over multiple ticks. Attachment files are retired transactionally and removed
with retry-safe filesystem cleanup. Chatty purging advances the private conversation generation.

### Peer backlog presentations (cxx 0.9.110)

Receivers advertise `capabilities.peer_batch_v1: true` alongside `queue_delivery_v1`.
With `CXX_PEER_BATCH_V1_ENABLED=true` (default), this negotiates full-content batching
independently of the opt-in preview digest flag and its host allowlist. Older receivers
retain their previous behavior. Set the new flag to `false` and recreate the API to
roll back this presentation policy.

When at least two untouched non-work messages wait and the oldest is at least 60 seconds
old, the receiver claims one `kind: digest` presentation with
`content.presentation: peer_batch_v1`. It owns the complete waiting backlog and initially carries up to 20 complete originals
within 12,000 UTF-8 JSON bytes, including sender, original message/conversation/reply IDs,
creation time, delivery class and full content. A non-null `next_after` requires reading the remaining originals through paginated
`agent_digest_get` in the same turn, including oversized entries; no content is truncated. This groups transport turns; it does not infer that a status is obsolete,
truncate answers, or silently acknowledge already-inspected messages. Advisor answers
are coordination and participate with every answer/turn intact. `advisor_status`,
`agent_wait` and message reads remain read-only.

Questions and coordination in a batch still require handling. Reply to the original
message ID, never the presentation. Call `agent_listen` once after handling all entries;
it releases only the presentation and leaves accepted work held. Work requests, wakes,
tasks, and replies to work (progress or results) retain individual delivery. Coordination
priority and FIFO position use the earliest original at that priority's dispatch order. Retained originals
are `batched` then `digested` on presentation acceptance, with no fabricated completion
or delivery attempts; `agent_message_get` and `agent_digest_get` retain full audit access.
Unpresented canceled/expired presentations or policy rollback restore eligible originals;
accepted or uncertain presentations never replay them. A receiver already running an
older wrapper must reconnect with cxx 0.9.110 to negotiate this behavior. Browser/OS
notification totals remain client-specific; the bound is on peer continuation deliveries.

## Workflows and shared runs

Agent `run-note`, `task-claim` and `task-update` mutation replies use compact
acknowledgements by default: run/task revisions, status, lease/claim fields,
preparation revision metadata and report URL. Full preparation instructions stay
available through `workflow_run_get`; admin and control responses remain complete.

See [Workflows](workflows.md) for state transitions, recovery and delivery. All admin endpoints require an authenticated session. Reads require `workflows.read`; definition mutations and state changes require `workflows.manage`; run mutations require `workflows.run`, enforced in both compatible and strict modes. Report access does not grant chat-body access. JSON API namespaces deliberately differ from the SPA route `/admin/workflows`.

- `GET /admin/workflow-definitions/state` — Read module availability.
- `POST /admin/workflow-definitions/state` — Set enabled with a stable client_request_id.
- `GET /admin/workflow-definitions` — List definitions with bounded pagination.
- `POST /admin/workflow-definitions` — Create a validated document and initial immutable version.
- `GET /admin/workflow-definitions/:id` — Read current definition.
- `GET /admin/workflow-definitions/:id/versions` — List immutable versions.
- `GET /admin/workflow-definitions/:id/versions/:version` — Read one pinned document and diff.
- `POST /admin/workflow-definitions/:id/revise` — Publish document using expected_workflow_version.
- `POST /admin/workflow-definitions/:id/archive` — Archive using expected_workflow_version and expected_control_version.
- `POST /admin/workflow-definitions/:id/restore` — Restore archived definition with both expected revisions.
- `POST /admin/workflow-definitions/:id/revert` — Publish the selected version as a new version; requires expected_workflow_version.
- `GET /admin/workflow-runs` — List runs by workflow/status with bounded pagination.
- `POST /admin/workflow-runs` — Prepare a pending run with workflow_id, version (latest or number), title and inputs.
- `GET /admin/workflow-runs/:id` — Read durable state, membership and task summaries.
- `GET /admin/workflow-runs/:id/events` — Read ordered events using the sequence cursor and limit.
- `GET /admin/workflow-runs/:id/report` — Read the live or frozen final report.
- `GET /admin/workflow-runs/:id/tasks/:taskId` — Read task attempts and evidence.
- `POST /admin/workflow-runs/:id/control` — Configure a pending run, pause/resume/block, request cancellation or recover coordinator according to actor authority.
- `POST /admin/workflow-runs/:id/prepare-cancel` — Cancel an unstarted preparation; preserves required evaluation state.

New runs expose `preparation: {phase, revision, notes, questions, summary, confirmation}`.
They stay `pending` throughout `clarifying` → `awaiting_confirmation` → `ready`;
agent creation and coordinator recovery do not start execution. Historical runs
have `preparation: null` and retain their previous behavior. New agent participation
requires authenticated session capability `workflow_protocol_version >= 2` (cxx 0.9.114);
protocol 1 may still drain historical runs.

Additional run-control actions, shared by admin HTTP and native MCP:

- `configure`: optional `title`, `inputs` and `questions: [{id, question, answer?}]`.
  Supplied answer/question collections replace their respective saved collections.
  Partial inputs are allowed; duplicate question IDs are rejected. Changes invalidate
  the summary and confirmation, retaining additional agreements and event history.
- `present_summary`: optional `notes` (defaults to empty). Validates required inputs
  and answered follow-ups, then snapshots title, goal, answers and planned tasks.
- `confirm_summary`: required `summary_revision`; agents additionally supply nonempty
  `user_confirmation` recording explicit user approval. Agent writes require current
  coordinator generation; an authorized admin may review and confirm without an agent.
  Confirmation records actor, timestamp and web/conversation channel.
- `coordinator_acquire` can acquire preparation ownership without execution. `start`
  requires the confirmed current summary and transitions to `running`. Task writes
  cannot bypass this gate. Every action retains version and idempotency fencing.

Bridge endpoints authenticate `x-agent-bridge-token` and derive address, host, engine and binding from the native session. Every operation except run-current requires a stable `client_request_id`; replay identical bodies after a lost response. Run controls require `expected_run_version`; coordinator writes also check `coordinator_generation`. Task writes use independent `expected_task_version`; claimed writes additionally require `claim_token` and `claim_generation`. Invalid documents fail validation; stale versions/bindings/claims return 409 without silently overwriting another actor. Full executable field schemas live in `api/src/services/workflows/contract.ts` and generate the native tool declarations.

- `POST /host/agent-sessions/:id/agent-messaging/workflows/create` — Create a definition.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/revise` — Publish an instruction revision using compare-and-swap.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/archive` — Archive or restore with instruction and control revisions.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-create` — Create a pending pinned run with the caller as preparation coordinator and member.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-control` — Start a prepared run or control/renew/transfer/recover coordinator ownership.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/invite` — Invite an active compatible target_address_id, with reason and optional task_ids.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/membership` — Accept/decline/revoke an invitation, leave or remove a participant.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/task-claim` — Acquire, renew, release or reconcile a task claim.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/task-update` — Record an explicit attempt result, retry or justified skip.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-note` — Append knowledge, an observation or an improvement suggestion.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-finish` — Assess all goal criteria and enter mandatory evaluation.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-evaluate` — Save or finalize evaluation; publish a validated improvement atomically.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-current` — Read current membership, invitations and pending evaluations for the authenticated binding; empty body. `server_time`, `stale_memberships` and `stale_claims` also expose recovery information for the same authenticated address's earlier bindings. These read-only projections contain no claim tokens and confer no write access. Stale membership identifies the prior session/generation with `binding_current: false` and `recovery_required: operator_coordinator_recover`; stale claims require `resolve_old_claim_then_operator_recovery`. An authorized admin uses the run-control `coordinator_recover` action with the current run version, target address, reason and stable request UUID. Outstanding earlier claims must be settled first; no implicit ownership transfer occurs.

A knowledge entry may opt in to required source checks with
`required_check: {applicability: "required scope and operating system"}`. Every task
whose `knowledge_ids` includes it requires an applicable receipt from the claiming
agent's current address/session/binding before `task-claim acquire` can start an attempt.
Absent opt-in, historical definitions and informational knowledge notes behave unchanged.

Record receipts with `run-note kind:knowledge`, optional `task_id`, and `source` containing
`knowledge_id` (from the pinned workflow), exact pinned `uri`, `title`, `read_at`,
`summary`, `applicability` (`applicable|mismatch|unknown`) and `applicability_reason`.
`read_at` must be at or after run creation and no later than server time. An applicable,
readable source needs a nonblank `digest` or `revision`. Inline sources use
`workflow://<run.workflow_sha256>/knowledge/<knowledge_id>` and a digest equal to SHA-256
of the canonical JSON encoding of the inline string in UTF-8. Referenced fingerprints
and applicability are agent attestations, not independent server verification; no URI
is fetched and no source commands are executed. Declared scope/OS is human-readable
applicability criteria that the agent must assess and explain.

An unavailable source (`unavailable:true`), applicability mismatch, unknown applicability
or missing receipt returns `409 workflow_knowledge_required` with per-source
`knowledge_checks`; no claim/attempt is created. Unreadable or inapplicable receipts
remain visible without requiring an unavailable fingerprint. With `task_id`, the task
must reference that knowledge ID. Without it, the receipt covers linked tasks in this
run. The latest task-specific receipt by event sequence wins, including later failures;
only when none exists does the latest run-wide receipt apply. A task-specific mismatch
therefore needs a new task-specific applicable receipt, even after a later run-wide read.
Other tasks' scoped receipts and other actor bindings cannot satisfy a claim. Once a
claim has started, later receipts do not terminate external execution. Task-detail
responses include `knowledge` with checks for the active claim owner, or the active
coordinator when unclaimed, and the exact subject binding/role. This is attributed
readiness for that subject only, not for all participants. Other receipts remain in
the paginated run history. Claim gates use a locked run row and at most 100 bounded
latest-receipt lookups, so notes and acquisitions serialize without a schema migration.
All three engines use the same contract; update cxx for the extended tool schemas.

Responses include canonical IDs, versions and an authenticated `report_url`; claims alone return the private claim token. Lists and task/event reads are bounded; follow returned pagination metadata. Evidence carries `id`, `description`, `type`, `time` and optional `uri`, `hash`, `execution_host`, `expires_at`; no arbitrary URI is fetched by the server. Definition changes publish `workflow.changed`, run progress publishes `workflow.run.changed`, and module changes publish `workflow.state.changed`; payloads invalidate query caches and do not carry private claim tokens or chat bodies.

## Account quota warnings and reset recovery (cxx 0.9.112)

- `GET /admin/quota-policy/:engine` and `PUT /admin/quota-policy/:engine` read/write engine defaults.
- `GET /admin/accounts/:id/quota-policy` and `PUT /admin/accounts/:id/quota-policy` read/write a complete account override. PUT accepts `{policy: {...}}`; `policy: null` restores inheritance. GET returns `defaults`, nullable `override` and `effective`.
- Policy fields: `unlimited` boolean; `short_warn_percent` and `long_warn_percent` (integer 1–100 or null to disable warnings); `short_auto_resume` and `long_auto_resume` booleans. Defaults: false, 85, 85, true, false respectively. PayG is an explicit account setting, not provider detection. Unlimited bypasses warnings, quota startup blocks and quota-triggered resume; provider billing remains separately configured.
- `POST /host/agent-sessions/:id/agent-messaging/quota/get` accepts `{}` and the session bridge token. The `cxx-agent` MCP tool `quota_get` uses this route without an account parameter. Account identity comes from `provider_session_id` supplied at lifecycle registration, validated against the authenticated host/engine's live provider lease. Older unbound sessions report `account_binding_unknown`.
- Readings include account, engine, policy, status, short/long windows with percentage, actual duration, source, observation timestamp and reset. Missing is not zero; readings older than ten minutes or past reset are stale. Codex/Grok refreshes retain existing throttles; Claude reads only native statusline reports. Grok can report weekly or monthly usage and has no fabricated short window.
- Fresh threshold crossings notify active sessions of the same account once per session/window/reset/severity. QUOTA/1 notices are informational, bound to the current lifecycle, and never wake an offline session.
- A native capacity failure plus a fresh exhausted quota window arms reset recovery when enabled. Overload alone and usage without a failed turn cannot arm it. A known long blocker takes precedence. Unknown scope is left for the operator.
- Recovery reuses the Watchdog schedule and native-session executor. It waits at least 60 seconds beyond all known blocking resets, rechecks effective policy and attempts, and stops on task completion, cancel, manual stop, changed native binding or missing transcript. PayG or a disabled policy cancels queued quota recovery. Initial attempt plus at most three retries (5, 15, 30 minutes when no newer reset exists); only persistent hosts start automatically. Stale post-reset readings permit a bounded probe. No replacement session or independent replacement subagent is created.
- `agent_watchdogs` exposes nullable `quota` metadata (account, window, reset, attempts and last attempt). Engine defaults live in Engines, account overrides in Accounts, and recovery state in the existing Watchdog panel. Warning thresholds do not force a pause. Managed instructions require quota_get before heavy work/delegation.

## Feedback sweep additions (2026-10-24)

- `POST /host/agent-sessions/:id/agent-messaging/git/remote` — bridge-authenticated `agent_git_remote`: `{target_host_id, claim_id, common_dir, branch, operation, args}`. Operations are `register|join|list|merge_request|merge_status|release`; `args.worktree_path` is required. Canonical absolute paths, the active originating binding and its remote path/branch claim are checked. `args.target_branch` must equal `branch`. Registration preserves the origin agent/session/generation; later operations cannot use a foreign registration or request. It records coordination only; the agent runs SSH and Git. Cross-host merge grants recheck live claim coverage after judging even if new coordination is disabled.
- MCP domain failures retain `isError:true`, JSON text `{error:{message,code,type,...safe_details}}` and matching `structuredContent`. Unknown exceptions retain their plain message; no stack or credential is added.
- `git_release` accepts `correction_id` (stable UUID) and `correction_reason` with a completed merged request and replacement full `target_head_sha`. This appends `git_director.outcome_correction` to the audit; the original report and ended lease remain unchanged. Corrections cannot deregister or release other work.
- `api_disabled` is admitted globally before authentication and handler work. Only the actual `/admin/api/state` route is exempt, including its supported trailing slash; SPA lookalikes remain disabled.
- `/auth` selects alternative quota advice from an enabled verified account of the correct engine (most recently selected first). Current-engine telemetry stays bound to its requested account; disabled/unlimited advice skips alternative history reads. No provider refresh or account lease is acquired for advice.

Claim-status reads/renewals in cxx 0.9.124 retry transient communicator 502/504 (and transport-unavailable 503) twice with bounded backoff. Explicit API-disable, authorization errors, owner responses and work mutations are never replayed by this path.


## Authoritative control-plane owner

Current runtime state and command/receipt semantics are specified in [control-plane-owner.md](control-plane-owner.md). `/readyz` reads the hydrated migration ledger and last observed runner health; it does not perform a new SQL or runner probe. Gateway key use counts are approximate, buffered for up to 30 seconds, and flushed on orderly shutdown. Signing-key mutations and mutating migration CLI operations require exclusive ownership while the API is stopped.

## Server history retention

`GET /admin/server-retention` (`settings.read`) returns effective policy, opaque
revision, validation limits, bounded run status, deadline obligations and fixed
receipt/Docker-log retention facts. Policy writes use
`POST /admin/server-retention` (`settings.manage`), with `{policy,expected_revision}`.
Allowed policy fields are `audit_days` and `quota_days` (integers 1–3650),
`history_hours` (1–87600), and `armed` (boolean). A stale revision returns 409
`retention_policy_changed`. The migration leaves additional cold cleanup unarmed;
existing lifecycle cleanup continues. The first exclusive bootstrap preserves
an existing portal retention environment value when seeding a missing policy.

`POST /admin/server-retention/preview` (`settings.read`) reads a consistent cold
snapshot and returns candidate/retained counts for audit, quota, command receipts,
ended portal sessions and conversations. Retained includes young and protected
rows. Rooms, identities and attachment children are checked by lifecycle batches;
previews are observations, not promises of deletion. No response contains bodies.

`POST /admin/server-retention/run` (`settings.manage`) requires
`{client_request_id:UUID,expected_revision}` and an armed policy; returns 202 with
the bounded run status. The stable request ID makes retries idempotent. A second
concurrent run returns 409. `GET /admin/server-retention/runs/:id` returns the
current retained run or 404 if its status slot was replaced. Progress is published
through existing settings/owner state events. Completion means the guarded pass
finished, not that protected data was removed.

External/legacy command results become compact fences after 14 days unless an
open effect/work binding needs them. A repeated matching command returns
`410 command_result_expired`; it is never prepared or executed again. A different
payload conflicts with 409, and current authorization is checked first. Explicit
internal IDs expire after seven days once unreferenced. No retry-window protocol
change or new client ID generation is introduced.

`node retention-maintenance.js --activate --no-backup` and
`--compact --no-backup` require exclusive offline database ownership. Compaction
uses a fixed table allowlist and only recorded families with actual deletions from
a completed run. `--preview` is read-only. These operations never create dumps,
volume snapshots or storage archives. Older images that do not understand compact
receipts are not a supported rollback after compaction; pin compatible code first.
