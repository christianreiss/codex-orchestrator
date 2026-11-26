# API route catalogue

Every HTTP route the API registers, one line per `METHOD /path`: who may call it, the capability where one applies, what it does, and where the spec lives. This page is a catalogue only. Request and response bodies, status codes, error envelopes and behaviour are specified in [interface-api.md](interface-api.md), the source of truth. The route-to-document tests pin this list against the registered routes in both directions.

Auth tags used below:

- **host key**: per-host API key (`X-API-Key` or `Authorization: Bearer`), bound to the host IP; see [Auth + IP rules](interface-api.md#auth--ip-rules).
- **bridge token** and **relay token**: per-launch or per-relay token issued at registration, sent in the bridge or relay token header.
- **admin session**: admin session cookie, then the named capability (see [Admin access control](interface-api.md#admin-access-control)). `public` admin routes are the documented login, reset and bundle exceptions.
- **device bearer**, **gateway key**, **external client key**, **connector token**, **path token**, **rescue media bearer**: credential classes of the respective surface; the spec section linked on each line defines them.
- **public**: no credential.

## Health and versions

Default spec section: [Host-facing](interface-api.md#host-facing); lines with another section link it.

- `GET /versions` — public: version snapshot, same block as `/auth`, served while the API kill switch is off
- `GET /healthz` — public: unauthenticated liveness probe: `{ok:true, ts}`
- `GET /readyz` — public: unauthenticated derived readiness probe

## Host auth, sync and cron

Default spec section: [Host-facing](interface-api.md#host-facing); lines with another section link it.

- `POST /sync/cache` — host key: communicator cache protocol 2 (cxx 0.9.122+) ([spec](interface-api.md#communicator-cache-protocol-2-cxx-09122))
- `DELETE /auth` — host key: `?engine=codex|claude|grok|kimi` removes only that engine from a multi-engine host ([spec](interface-api.md#auth--ip-rules))
- `POST /auth` — host key: unified retrieve/store
- `POST /sync/status` — host key: periodic check-in
- `POST /claude/usage/report` — host key: host reports what Claude Code's own statusLine payload said for the current `rate_limits` reading
- `POST /sync/bootstrap` — host key: batched startup payload endpoint
- `POST /host/users` — host key: records `username` and optional `hostname` for the calling host, returning known users with `first_seen`/`last_seen`
- `GET /host/model-defaults/{engine}` — host key: returns the engine's central fleet model/effort and persistent-effort catalog using the same ([spec](interface-api.md#host-fleet-model-defaults-cxx-09183))
- `POST /host/model-defaults/{engine}` — host key: saves exactly `{model, reasoning_effort}` as the selected engine's central default ([spec](interface-api.md#host-fleet-model-defaults-cxx-09183))
- `GET /host/lane` — host key: returns lane metadata for the calling host
- `POST /host/lane` — host key: sets/clears host lane preference
- `POST /cron/check` — host key: auto-update probe for the host cron entry
- `POST /cron/report` — host key: host reports its installed versions
- `GET /skills` — host key: list the canonical skill manifests
- `POST /auth/sessions` — host key: host-key/IP/security gated `{engine, scope_id, session_id, account_id?}` ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `POST /auth/sessions/heartbeat` — host key: `{engine, session_id}` extends a live, host-owned lease by five minutes ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `POST /auth/sessions/release` — host key: `{engine, session_id}` idempotently releases that host's reservation and drains pending removal ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `GET /auth/accounts` — host key: `?engine&session_id?` account pool metadata, distribution policy, this scope's binding and the pool recommendation ([spec](interface-api.md#claude-multiple-accounts-and-live-switching))
- `POST /auth/sessions/switch-request` — host key: `{engine, session_id, account_id|"auto", reason?}` asks to move this session's scope to another account at the next turn boundary ([spec](interface-api.md#claude-multiple-accounts-and-live-switching))
- `POST /auth/sessions/switch` — host key: `{engine, session_id, scope_id, account_id, binding_generation}` commits a requested switch and returns the new account's auth ([spec](interface-api.md#claude-multiple-accounts-and-live-switching))

## Wrapper, installer and rescue media

Default spec section: [Installer](interface-api.md#installer); lines with another section link it.

- `GET /wrapper/v2/config` — host key: signed per-host wrapper config JSON (`{payload, signature, signatures}`) ([spec](interface-api.md#host-facing))
- `GET /wrapper/v2/bin/{artifact}/{platform}/v{version}/{binary}` — host key: versioned binary route ([spec](interface-api.md#host-facing))
- `GET /wrapper/v2/download/{artifact}/{platform}/v{version}/{binary}` — host key: same exact-version artifact under a `/download` path ([spec](interface-api.md#host-facing))
- `POST /rescue/v1/session` — rescue media bearer: rescue-media session control (start, heartbeat, release, version) ([spec](interface-api.md#rescue-media))
- `GET /install/{token}` — path token: public, non-consuming preflight launcher: a credential-free script that checks `python3`
- `POST /install/{token}` — path token: public single-use installer claim
- `GET /install/v2/{token}` — path token: alias of `GET /install/{token}`
- `POST /install/v2/{token}` — path token: alias of `POST /install/{token}`
- `GET /seed/v2/auth/{token}` — path token: alias of `GET /seed/auth/{token}` ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /seed/v2/auth/{token}` — path token: alias of `POST /seed/auth/{token}` ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /seed/auth/{token}` — path token: serve engine-specific seed shell script ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /seed/auth/{token}` — path token: accept raw credential payload (or `{ "auth": ... }`), require positive live runner validation ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /wrapper/v2/rtk/v{version}/{platform}` — host key: host-authenticated verified OSS archive ([spec](interface-api.md#rtk-policy-and-readiness-api))

## MCP and OAuth connectors

Default spec section: [OAuth chat connectors](interface-api.md#oauth-chat-connectors); lines with another section link it.

- `GET /mcp` — public: probe endpoint ([spec](interface-api.md#host-facing))
- `POST /mcp` — host key or MCP session credential: JSON-RPC 2.0 endpoint (single or batch) ([spec](interface-api.md#host-facing))
- `GET /.well-known/oauth-protected-resource/connectors/mcp` — public: OAuth protected-resource metadata for the connector MCP endpoint
- `GET /.well-known/oauth-authorization-server` — public: OAuth authorization-server metadata
- `POST /oauth/register` — public: dynamic client registration for chat connectors
- `GET /oauth/authorize` — public: start the authorization-code flow and redirect to the admin consent screen
- `POST /oauth/token` — public: exchange an authorization code or refresh token (the grant is the credential)
- `POST /oauth/revoke` — public: revoke a connector access or refresh token
- `GET /connectors/mcp` — connector token: connector MCP endpoint probe
- `POST /connectors/mcp` — connector token: connector MCP JSON-RPC endpoint (bearer scoped to the consented connection)

## Inference gateways

Default spec section: [Host-facing](interface-api.md#host-facing); lines with another section link it.

Gateway keys belong to the surface (key namespace), not to the engine that answers. See Exposed API routing in the spec.

- `POST /v1/chat/completions` — gateway key: openAI-compatible chat completion route
- `POST /v1/responses` — gateway key: minimal non-streaming Responses API compatibility adapter
- `POST /v1/completions` — gateway key: legacy text completion route
- `GET /v1/models` — gateway key: list the supported Codex model ids from the shared config/model allowlist
- `GET /v1/models/{model}` — gateway key: retrieve one model object
- `POST /v1/embeddings` — gateway key: currently returns `501 not_implemented` for the bundled backend
- `OPTIONS /v1/*` — public: CORS preflight catch-all for every OpenAI-compatible route
- `POST /anthropic/v1/messages` — gateway key: anthropic-compatible Messages API ([spec](interface-api.md#post-anthropicv1messages))
- `POST /anthropic/v1/messages/count_tokens` — gateway key: token count estimate for a prospective request ([spec](interface-api.md#post-anthropicv1messagescount_tokens))
- `POST /anthropic/v1/completions` — gateway key: legacy text completion endpoint ([spec](interface-api.md#post-anthropicv1completions))
- `POST /anthropic/v1/complete` — gateway key: upstream spelling of the legacy text-completion route; same handler ([spec](interface-api.md#post-anthropicv1completions))
- `POST /anthropic/v1/responses` — gateway key: responses API compatibility adapter (non-streaming only) ([spec](interface-api.md#post-anthropicv1responses))
- `GET /anthropic/v1/models` — gateway key: list available Claude models, in the Anthropic Models API shape ([spec](interface-api.md#get-anthropicv1models))
- `GET /anthropic/v1/models/{model_id}` — gateway key: retrieve one model ([spec](interface-api.md#get-anthropicv1modelsmodel_id))
- `POST /anthropic/v1/embeddings` — gateway key: embeddings (not implemented by the backend) ([spec](interface-api.md#post-anthropicv1embeddings))
- `OPTIONS /anthropic/v1/*` — public: CORS preflight catch-all for every Anthropic-compatible route ([spec](interface-api.md#cors-preflight))
- `OPTIONS /kimi/v1/*` — public: open CORS preflight, no gateway key required ([spec](interface-api.md#kimi-inference-gateway))
- `POST /kimi/v1/chat/completions` — gateway key: text chat, scoped bearer required ([spec](interface-api.md#kimi-inference-gateway))
- `POST /kimi/v1/responses` — gateway key: text Responses API, scoped bearer required ([spec](interface-api.md#kimi-inference-gateway))
- `POST /kimi/v1/completions` — gateway key: legacy text completion, scoped bearer required ([spec](interface-api.md#kimi-inference-gateway))
- `POST /kimi/v1/embeddings` — gateway key: explicit `400 unsupported_endpoint` ([spec](interface-api.md#kimi-inference-gateway))
- `GET /kimi/v1/models` — gateway key: enabled backend models (MoonshotAI catalog by default) ([spec](interface-api.md#kimi-inference-gateway))
- `GET /kimi/v1/models/{model}` — gateway key: strict single-model lookup ([spec](interface-api.md#kimi-inference-gateway))
- `OPTIONS /grok/v1/*` — public: CORS preflight, without gateway auth ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /grok/v1/chat/completions` — gateway key: grok subscription chat completion, scoped bearer required ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /grok/v1/responses` — gateway key: grok text response, scoped bearer required ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /grok/v1/completions` — gateway key: grok legacy text completion, scoped bearer required ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /grok/v1/embeddings` — gateway key: unsupported endpoint, explicit non-retriable400 ([spec](interface-api.md#grok-endpoint-inventory))
- `GET /grok/v1/models` — gateway key: enabled Grok native model catalog ([spec](interface-api.md#grok-endpoint-inventory))
- `GET /grok/v1/models/{model}` — gateway key: retrieve an enabled native model ([spec](interface-api.md#grok-endpoint-inventory))

## External clients

Default spec section: [External clients](interface-api.md#external-clients); lines with another section link it.

- `GET /external/v1/inbox` — external client key: long-poll (`wait` 0–25 s) for the next message
- `POST /external/v1/inbox/ack` — external client key: acknowledge `message_ids`
- `POST /external/v1/send` — external client key: send to a name or `agent:UUID`
- `POST /external/v1/reply` — external client key: reply to a received message
- `POST /external/v1/result` — external client key: report a work outcome (`succeeded|failed|blocked|unknown`)
- `POST /external/v1/heartbeat` — external client key: keep presence between polls
- `GET /external/v1/agents` — external client key: peer discovery without hosts or paths

## Agent sessions, portal and messaging (host-facing)

Default spec section: [Agent Messaging](interface-api.md#agent-messaging); lines with another section link it.

Bridge-token routes are scoped to one launched session; relay-token routes to one host-user relay. The host key only registers the session or relay.

- `POST /host/agent-sessions/{id}/agent-messaging/digest` — bridge token: bridge-authenticated original retrieval for a negotiated smart-queue digest ([spec](interface-api.md#communicator-cache-protocol-2-cxx-09122))
- `POST /host/agent-sessions` — host key: host-authenticated registration for an eligible interactive or human-started execute session ([spec](interface-api.md#host-registration-and-bridge))
- `POST /host/agent-sessions/{id}/agent-messaging/groups/list` — bridge token: list persistent groups and subscription limits
- `POST /host/agent-sessions/{id}/agent-messaging/groups/create` — bridge token: create `{slug,title,description?}` without joining automatically
- `POST /host/agent-sessions/{id}/agent-messaging/groups/detail` — bridge token: inspect one `{slug}` and its members
- `POST /host/agent-sessions/{id}/agent-messaging/groups/delete` — bridge token: creator-only deletion of `{slug}`
- `POST /host/agent-sessions/{id}/agent-messaging/subscribe` — bridge token: opt in to `{topic}` (`group:<slug>` or an individual `agent:<uuid>` feed)
- `POST /host/agent-sessions/{id}/agent-messaging/unsubscribe` — bridge token: leave `{topic}`, affecting future publications
- `POST /host/agent-sessions/{id}/agent-messaging/subscriptions` — bridge token: list the caller's explicit subscriptions
- `POST /host/agent-sessions/{id}/agent-messaging/publish` — bridge token: atomically enqueue explicit publications for subscribed eligible members
- `POST /host/agent-sessions/{id}/agent-messaging/list` — bridge token: discover eligible peers, optionally filtered by engine/host/offline state
- `POST /host/agent-sessions/{id}/agent-messaging/send` — bridge token: enqueue `content` for `to` with UUID `client_message_id`
- `POST /host/agent-sessions/{id}/agent-messaging/reply` — bridge token: reply to a message with a new sender idempotency UUID
- `POST /host/agent-sessions/{id}/agent-messaging/wait` — bridge token: sequence-cursor long poll for a conversation (maximum 25 seconds)
- `POST /host/agent-sessions/{id}/agent-messaging/message` — bridge token: read one message visible to the participant
- `POST /host/agent-sessions/{id}/agent-messaging/cancel` — bridge token: cancel an open participant conversation
- `POST /host/agent-sessions/{id}/agent-messaging/mailbox` — bridge token: the ring: report what is queued for this session, plus messages that recently expired unanswered
- `POST /host/agent-sessions/{id}/agent-messaging/conf/open` — bridge token: open a conference and become its chair
- `POST /host/agent-sessions/{id}/agent-messaging/conf/list` — bridge token: the caller's live rooms (chair, invited or member) with role, state, member count and budget
- `POST /host/agent-sessions/{id}/agent-messaging/conf/invite` — bridge token: chair only. Invite up to 8 addresses or aliases
- `POST /host/agent-sessions/{id}/agent-messaging/conf/join` — bridge token: join by room PIN or by the `conference_id` from an invitation (exactly one)
- `POST /host/agent-sessions/{id}/agent-messaging/conf/roster` — bridge token: list members with host, engine, role, declared purpose, delivery mode and floor state
- `POST /host/agent-sessions/{id}/agent-messaging/conf/say` — bridge token: chair broadcasts to seated members or one named member
- `POST /host/agent-sessions/{id}/agent-messaging/conf/dispatch` — bridge token: chair only. Hand one member a task and take it off the floor until it reports
- `POST /host/agent-sessions/{id}/agent-messaging/conf/adjourn` — bridge token: chair only. Graceful by default: members still working finish first and the room reports `adjourning`
- `POST /host/agent-sessions/{id}/agent-messaging/bind` — bridge token: publish native adapter protocol/capabilities, receive readiness, upstream continuity
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/claim` — bridge token: claim one delivery with an idempotent claim UUID and optional long poll
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/renew` — bridge token: renew the owned 60-second lease
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/ack` — bridge token: acknowledge `accepted|completed|retry|dead|ambiguous`
- `POST /host/agent-relays/register` — host key: register/replace the host-user relay
- `POST /host/agent-relays/{id}/heartbeat` — relay token: refresh heartbeat and token expiry
- `POST /host/agent-relays/{id}/stop` — relay token: stop the relay and erase its token
- `POST /host/agent-relays/{id}/deliveries/claim` — relay token: claim one dormant-address delivery
- `POST /host/agent-relays/{id}/deliveries/{messageId}/renew` — relay token: renew the relay-owned lease
- `POST /host/agent-relays/{id}/deliveries/{messageId}/reply` — relay token: persist a reply for the owned delivery
- `POST /host/agent-relays/{id}/deliveries/{messageId}/ack` — relay token: acknowledge the relay-owned delivery
- `GET /host/agent-portal/state` — host key: host-authenticated master-switch probe ([spec](interface-api.md#host-registration-and-bridge))
- `POST /host/agent-sessions/{id}/activity` — bridge token: native activity snapshot with receiver/native/binding generation and sequence fencing ([spec](interface-api.md#audit-corrections-host-lifecycle-and-quota-observations))
- `POST /host/agent-sessions/{id}/heartbeat` — bridge token: scoped-bearer heartbeat/rolling expiry renewal ([spec](interface-api.md#host-registration-and-bridge))
- `POST /host/agent-sessions/{id}/events` — bridge token: scoped-bearer idempotent safe event publish ([spec](interface-api.md#host-registration-and-bridge))
- `POST /host/agent-sessions/{id}/finish` — bridge token: idempotent, atomic completed/failed event + terminal transition + pending-work cancellation ([spec](interface-api.md#host-registration-and-bridge))
- `POST /host/agent-sessions/{id}/commands/claim` — bridge token: strict FIFO long poll with `{wait_seconds?: 0..25, claim_id: UUID}` and a retryable 30-second ([spec](interface-api.md#host-registration-and-bridge))
- `POST /host/agent-sessions/{id}/receiver/register` — bridge token: automatic-receiver registration for a generation and protocol ([spec](interface-api.md#automatic-receiver-protocol-0810))
- `POST /host/agent-sessions/{id}/receiver/heartbeat` — bridge token: `{generation}` renews native receiver health, which expires after 45 seconds and cannot be revived ([spec](interface-api.md#automatic-receiver-protocol-0810))
- `POST /host/agent-sessions/{id}/receiver/stop` — bridge token: `{generation, failure?}` stops the receiver ([spec](interface-api.md#automatic-receiver-protocol-0810))
- `POST /host/agent-sessions/{id}/receiver/ack` — bridge token: deprecated compatibility endpoint for already-delivered legacy probes (`{generation, source, nonce}`) ([spec](interface-api.md#automatic-receiver-protocol-0810))
- `POST /host/agent-sessions/{id}/receiver/status` — bridge token: returns `receiver` ([spec](interface-api.md#automatic-receiver-protocol-0810))
- `POST /host/agent-sessions/{id}/receiver/claim` — bridge token: strict `{generation, source: "peer"|"portal", claim_id: UUID}` claims an existing queue `delivery` ([spec](interface-api.md#automatic-receiver-protocol-0810))
- `POST /host/agent-commands/{messageId}/ack` — bridge token: explicit acceptance/retry acknowledgement ([spec](interface-api.md#host-registration-and-bridge))
- `POST /host/agent-sessions/{id}/schedule-policy` — bridge token: bridge-authenticated current-session watchdog policy ([spec](interface-api.md#agent-wake--cron-schedules))
- `POST /host/agent-messaging/translate` — host key: read-only host-authenticated name/UUID lookup with `{value: string}` ([spec](interface-api.md#german-launch-names-and-translation))
- `POST /host/agent-sessions/{id}/agent-messaging/translate` — bridge token: name/UUID lookup using the launch bridge token ([spec](interface-api.md#german-launch-names-and-translation))
- `POST /host/agent-sessions/{id}/agent-messaging/self` — bridge token: authenticated current launch name, UUID, native binding and task-title metadata ([spec](interface-api.md#german-launch-names-and-translation))
- `POST /host/agent-messaging/list` — host key: read-only host-scope inventory of this host's registered agents for operator shells ([spec](interface-api.md#german-launch-names-and-translation))
- `GET /host/agent-sessions/{id}/watchdog/stream` — bridge token: watchdog activity stream for the session ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/agent-sessions/{id}/watchdog/activity` — bridge token: report session activity to the watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/agent-sessions/{id}/agent-messaging/watchdog/get` — bridge token: read the session watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/agent-sessions/{id}/agent-messaging/watchdog/enable` — bridge token: enable the session watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/agent-sessions/{id}/agent-messaging/watchdog/disable` — bridge token: disable the session watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/agent-sessions/{id}/agent-messaging/watchdog/finish` — bridge token: finish the session watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/agent-sessions/{sessionId}/agent-messaging/spawn` — bridge token: start a helper session on a host daemon ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /host/agent-sessions/{sessionId}/agent-messaging/spawn-status` — bridge token: track a spawned helper ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /host/agent-sessions/{sessionId}/agent-messaging/stop` — bridge token: stop a helper this session spawned ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /host/agent-sessions/{sessionId}/agent-messaging/advisor/ask` — bridge token: ask the server-hosted advisor ([spec](interface-api.md#fleet-advisor))
- `POST /host/agent-sessions/{sessionId}/agent-messaging/advisor/close` — bridge token: close an advisor session ([spec](interface-api.md#fleet-advisor))
- `POST /host/agent-sessions/{sessionId}/agent-messaging/advisor/status` — bridge token: list advisor models and session state ([spec](interface-api.md#fleet-advisor))
- `POST /host/agent-sessions/{sessionId}/agent-messaging/insecure-enable` — bridge token: authenticated secure-host agent opens the target insecure window ([spec](interface-api.md#persistent-daemon-on-insecure-hosts))
- `POST /host/agent-sessions/{id}/agent-messaging/reboot/prepare` — bridge token: prepare a planned host reboot ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/agent-sessions/{id}/agent-messaging/reboot/arm` — bridge token: arm a planned host reboot ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/agent-sessions/{id}/agent-messaging/reboot/status` — bridge token: read planned-reboot state ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/agent-sessions/{id}/agent-messaging/reboot/restore` — bridge token: restore the session after the reboot ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/agent-sessions/{id}/agent-messaging/reboot/disarm` — bridge token: disarm a pending planned reboot ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/agent-sessions/{id}/attachments` — bridge token: create/resume upload: {id,name,mime_type,size_bytes,sha256?} ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /host/agent-sessions/{id}/attachments/{attachmentId}/chunks` — bridge token: upload {offset,content_b64} ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /host/agent-sessions/{id}/attachments/{attachmentId}/seal` — bridge token: seal completed bytes after SHA-256 verification ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /host/agent-sessions/{id}/attachments/get` — bridge token: host bridge chunk download: {attachment_id,variant?,offset?} ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `GET /host/communicator/connect` — host key: communicator WebSocket multiplexing host routes, MCP and daemon frames ([spec](interface-api.md#communicator-transport-endpoints))
- `POST /host/native-control/receipt` — host key: report a native-control result (control_state_v1) ([spec](interface-api.md#live-topology-endpoints))
- `POST /host/agent-sessions/{id}/native-control` — bridge token: register or poll the native-control capability and report stop receipts ([spec](interface-api.md#live-topology-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/roles/activate` — bridge token: activate an agent role (`agent_role_activate`) ([spec](interface-api.md#agent-role-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/roles/current` — bridge token: read the active role ([spec](interface-api.md#agent-role-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/roles/release` — bridge token: release the active role ([spec](interface-api.md#agent-role-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/roles/propose` — bridge token: propose a role ([spec](interface-api.md#agent-role-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/roles/proposals` — bridge token: list role proposals ([spec](interface-api.md#agent-role-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/roles/review` — bridge token: review a role proposal ([spec](interface-api.md#agent-role-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/context/get` — bridge token: read the session scope context ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/context/update` — bridge token: update the session scope context ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/rooms/list` — bridge token: list scope rooms ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/rooms/read` — bridge token: read a scope room ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/rooms/send` — bridge token: post to a scope room (alias of chats/send) ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/claims/acquire` — bridge token: acquire a resource claim ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/claims/status` — bridge token: read resource-claim status ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/claims/release` — bridge token: release a resource claim ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /host/agent-sessions/{id}/agent-messaging/chats/list` — bridge token: list shared chat rooms ([spec](interface-api.md#shared-conversations))
- `POST /host/agent-sessions/{id}/agent-messaging/chats/read` — bridge token: read a shared chat room ([spec](interface-api.md#shared-conversations))
- `POST /host/agent-sessions/{id}/agent-messaging/chats/send` — bridge token: post to a shared chat room ([spec](interface-api.md#shared-conversations))
- `POST /host/agent-sessions/{id}/agent-messaging/chats/{roomId}/attachments` — bridge token: start a chat-room attachment upload ([spec](interface-api.md#shared-conversations))
- `POST /host/agent-sessions/{id}/agent-messaging/chats/{roomId}/attachments/{attachmentId}/chunks` — bridge token: upload an attachment chunk ([spec](interface-api.md#shared-conversations))
- `POST /host/agent-sessions/{id}/agent-messaging/chats/{roomId}/attachments/{attachmentId}/seal` — bridge token: seal an uploaded attachment ([spec](interface-api.md#shared-conversations))
- `POST /host/agent-sessions/{id}/agent-messaging/chats/{roomId}/attachments/get` — bridge token: download a chat-room attachment ([spec](interface-api.md#shared-conversations))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/create` — bridge token: create a definition ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/revise` — bridge token: publish an instruction revision using compare-and-swap ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/archive` — bridge token: archive or restore with instruction and control revisions ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/run-create` — bridge token: create and start a pinned run with the caller as coordinator and member ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/run-control` — bridge token: start a prepared run or control/renew/transfer/recover coordinator ownership ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/invite` — bridge token: invite an active compatible target_address_id, with reason and optional task_ids ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/membership` — bridge token: accept/decline/revoke an invitation, leave or remove a participant ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/task-claim` — bridge token: acquire, renew, release or reconcile a task claim ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/task-update` — bridge token: record an explicit attempt result, retry or justified skip ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/run-note` — bridge token: append knowledge, an observation or an improvement suggestion ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/run-finish` — bridge token: assess all goal criteria and enter mandatory evaluation ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/run-evaluate` — bridge token: save or finalize evaluation ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/workflows/run-current` — bridge token: recover current membership, invitations and pending evaluations for the authenticated binding ([spec](interface-api.md#workflows-and-shared-runs))
- `POST /host/agent-sessions/{id}/agent-messaging/quota/get` — bridge token: read quota for the session account ([spec](interface-api.md#account-quota-warnings-and-reset-recovery-cxx-09112))
- `POST /host/agent-sessions/{id}/agent-messaging/git/remote` — bridge token: run a git operation on a target host under a claim (`agent_git_remote`) ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /host/agent-sessions/{id}/agent-messaging/work-state` — bridge token: current bridge only: `{}` reads state ([spec](interface-api.md#fleet-task-supervisor))

## Host runtime services

- `POST /host/engine-destroy/report` — host key: report per-host engine-destroy progress ([spec](interface-api.md#engine-destroy))
- `POST /host/watchdogs/get` — host key: read a host-level watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/watchdogs/enable` — host key: enable a host-level watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/watchdogs/disable` — host key: disable a host-level watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /host/daemon/migration` — host key: UUID-scoped fence, status and release for resident-runtime migration ([spec](interface-api.md#communicator-sync-ownership))
- `GET /host/daemon/config` — host key: host-daemon settings ([spec](interface-api.md#daemon-http-surfaces))
- `GET /host/daemon/connect` — host key: host-daemon WebSocket ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /host/daemon/peer-finished` — host key: report a finished peer message to the daemon ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /host/session-housekeeping/inspect` — host key: read the effective housekeeping policy and protected native IDs ([spec](interface-api.md#local-session-housekeeping))
- `POST /host/session-housekeeping/reserve` — host key: reserve this host/engine for a housekeeping run ([spec](interface-api.md#local-session-housekeeping))
- `POST /host/session-housekeeping/release` — host key: release a housekeeping reservation ([spec](interface-api.md#local-session-housekeeping))
- `POST /host/session-housekeeping/report` — host key: report bounded housekeeping counts and bytes ([spec](interface-api.md#local-session-housekeeping))
- `POST /host/reboot-handoffs/ready` — host key: mark a reboot handoff ready ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/reboot-handoffs/observe` — host key: observe a reboot handoff ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/reboot-handoffs/disarm` — host key: disarm a reboot handoff ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/reboot-handoffs/finish` — host key: finish a reboot handoff ([spec](interface-api.md#planned-reboot-handoff-protocol-1))
- `POST /host/spawn/setup-complete` — host key: installer reports successful setup on a spawned host ([spec](interface-api.md#system-spawn-new-system-provisioning))
- `POST /host/transfers` — host key: create or repeat an upload by stable UUID and declared size/hash/TTL ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /host/transfers/{id}` — host key: read metadata and the confirmed upload offset ([spec](interface-api.md#admin-admin-session-cookie))
- `PUT /host/transfers/{id}/content` — host key: append raw binary bytes at the explicit `offset` query value with `Content-Length` ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /host/transfers/{id}/complete` — host key: verify size/hash and make the file available ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /host/transfers/{id}/content` — host key: stream a live file, with optional open-ended HTTP byte range ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /host/rtk/report` — host key: host-authenticated bounded readiness metadata ([spec](interface-api.md#rtk-policy-and-readiness-api))

## Android companion

Default spec section: [Android companion](interface-api.md#android-companion); lines with another section link it.

The paired user's role gates each route by capability; where a line names capabilities they are enforced per route. The spec section covers the rest.

- `POST /companion/v1/pair` — pairing token: exchange a QR pairing token once for a device token
- `GET /companion/v1/hosts` — device bearer: hosts visible to the paired device (needs `admin.read`)
- `GET /companion/v1/quotas` — device bearer: engine quotas (`admin.read` and `auth.read_metadata`) ([spec](interface-api.md#android-engine-quotas-059))
- `POST /companion/v1/daemon-sessions` — device bearer: start a daemon session on a host
- `POST /companion/v1/daemon-sessions/{id}/stop` — device bearer: stop a daemon session (`agent_messaging.manage`)
- `POST /companion/v1/daemon-sessions/{id}/permission-mode` — device bearer: change daemon-session permission mode (`agent_messaging.manage`, `agent_portal.manage`)
- `GET /companion/v1/workflow-runs` — device bearer: list workflow runs (`workflows.read`)
- `GET /companion/v1/schedules` — device bearer: list schedules (`agent_messaging.read`)
- `POST /companion/v1/schedules/{id}/pause` — device bearer: pause a schedule (`agent_messaging.manage`)
- `POST /companion/v1/schedules/{id}/resume` — device bearer: resume a schedule (`agent_messaging.manage`)
- `GET /companion/v1/git-director/merges` — device bearer: pending Git Director merges (`git_director.read`)
- `GET /companion/v1/projects` — device bearer: list projects (`projects.read`)
- `GET /companion/v1/projects/{slug}/board` — device bearer: project board (`projects.read`)
- `POST /companion/v1/feedback` — device bearer: submit orchestrator feedback (`feedback.manage`)
- `GET /companion/v1/me` — device bearer: identity, current capabilities, public Firebase configuration, notification preference
- `PATCH /companion/v1/device` — device bearer: optional `fcm_token` (nullable), `notifications` boolean, `visible_session_id`
- `DELETE /companion/v1/device` — device bearer: self-revoke on logout
- `GET /companion/v1/agents` — device bearer: portal snapshot (`agents`, `generated_at`, `timings`), using `agent_portal.read`
- `POST /companion/v1/agents` — device bearer: portal snapshot with per-session read cursors (at most 500)
- `GET /companion/v1/agents/{id}/events` — device bearer: bounded timeline, `after` cursor and optional `tail=1`
- `GET /companion/v1/ws` — device bearer: native Bearer WebSocket for foreground live updates, independently of the admin WebSocket toggle
- `GET /companion/v1/events` — device bearer: legacy resumable foreground SSE using `after` and optional `session_id`
- `POST /companion/v1/agents/{id}/messages` — device bearer: `{client_message_id,content}`, returns 202 and follows this conversation
- `POST /companion/v1/agents/{id}/messages/{messageId}/cancel` — device bearer: `{}`; withdraws a still-`queued` operator message (200, repeat returns `already_canceled:true`)
- `POST /companion/v1/agents/{id}/prompts/{promptId}/answer` — device bearer: answer an open prompt (202, first answer wins)
- `PUT /companion/v1/agents/{id}/follow` — device bearer: `{followed}` changes reply notifications for this device
- `GET /companion/v1/approvals` — device bearer: current host-access `requests` plus default/max duration, currently 480 minutes
- `POST /companion/v1/hosts/{hostId}/insecure/disable` — device bearer: close a host insecure window (`hosts.activate_insecure`)
- `POST /companion/v1/hosts/{hostId}/insecure/enable` — device bearer: open a host insecure window (`hosts.activate_insecure`)
- `POST /companion/v1/insecure/window/close` — device bearer: close the active insecure window (`hosts.activate_insecure`)
- `POST /companion/v1/approvals/{requestId}/approve` — device bearer: optional `{duration_minutes}` in 0–480, defaults to 480
- `POST /companion/v1/approvals/{requestId}/deny` — device bearer: deny the current pending request
- `GET /companion/v1/agent-chat/limits` — device bearer: effective upload limits (paired device) ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /companion/v1/agents/{id}/attachments` — device bearer: create/resume upload: {id,name,mime_type,size_bytes,sha256?} ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /companion/v1/agents/{id}/attachments/{attachmentId}/chunks` — device bearer: upload {offset,content_b64} ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /companion/v1/agents/{id}/attachments/{attachmentId}/seal` — device bearer: seal completed bytes after SHA-256 verification ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `GET /companion/v1/agents/{id}/attachments/{attachmentId}` — device bearer: return name, MIME, size, SHA-256, upload offset and processing status ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `GET /companion/v1/agents/{id}/attachments/{attachmentId}/content` — device bearer: stream original or ?variant=transcript.json|frame-NN.jpg ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `DELETE /companion/v1/agents/{id}/attachments/{attachmentId}` — device bearer: discard the authenticated author's unlinked upload ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /companion/v1/agents/{id}/notices/resolve` — device bearer: resolve {notice_id,client_event_id} explicitly ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `GET /companion/v1/rooms` — device bearer: list shared rooms (`agent_messaging.read`) ([spec](interface-api.md#shared-conversations))
- `GET /companion/v1/rooms/candidates` — device bearer: participants a room can add (`agent_messaging.manage`) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/read` — device bearer: read a room (`agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/seen` — device bearer: mark a room seen (`agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `GET /companion/v1/rooms/changes` — device bearer: room change feed (`agent_messaging.read`) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/{roomId}/events/{eventId}/reactions` — device bearer: react to a room event (`agent_messaging.manage`, `agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/{roomId}/events/{eventId}/pin` — device bearer: pin or unpin a room event (same two capabilities) ([spec](interface-api.md#shared-conversations))
- `GET /companion/v1/rooms/{roomId}/pins` — device bearer: pinned events (`agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `GET /companion/v1/search` — device bearer: search room and chat content (`agent_messaging.reveal_content`; direct chats also `agent_portal.reveal_transcript`) ([spec](interface-api.md#shared-conversations))
- `GET /companion/v1/rooms/{roomId}/notifications` — device bearer: read room notification preference (`agent_messaging.read`) ([spec](interface-api.md#shared-conversations))
- `PUT /companion/v1/rooms/{roomId}/notifications` — device bearer: set room notification preference (`agent_messaging.read`) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/send` — device bearer: post to a room (`agent_messaging.manage`, `agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/create` — device bearer: create a room (same two capabilities) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/manage` — device bearer: manage room members and settings (same two capabilities) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/{roomId}/attachments` — device bearer: start a room attachment upload (both room capabilities) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/{roomId}/attachments/{attachmentId}/chunks` — device bearer: upload an attachment chunk (both room capabilities) ([spec](interface-api.md#shared-conversations))
- `POST /companion/v1/rooms/{roomId}/attachments/{attachmentId}/seal` — device bearer: seal an attachment (both room capabilities) ([spec](interface-api.md#shared-conversations))
- `GET /companion/v1/rooms/{roomId}/attachments/{attachmentId}` — device bearer: attachment metadata (`agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `GET /companion/v1/rooms/{roomId}/attachments/{attachmentId}/content` — device bearer: download attachment content (same read gates) ([spec](interface-api.md#shared-conversations))
- `DELETE /companion/v1/rooms/{roomId}/attachments/{attachmentId}` — device bearer: discard an unlinked upload (both room capabilities) ([spec](interface-api.md#shared-conversations))

## Admin: session, users and setup

Default spec section: [Admin (admin session cookie)](interface-api.md#admin-admin-session-cookie); lines with another section link it.

- `GET /admin/auth/status` — public: login-screen probe: session and setup state
- `POST /admin/auth/login/method` — public: ask which login methods a username offers
- `POST /admin/auth/login` — public: password login
- `POST /admin/auth/logout` — admin session, `account.self_manage`: clears session
- `POST /admin/auth/passkey/login/options` — public: passkey assertion challenge for a username
- `POST /admin/auth/passkey/login` — public: completes passkey login and sets the admin session cookie
- `POST /admin/auth/passkey/register/options` — admin session, `account.self_manage`: passkey registration challenge for the signed-in user
- `POST /admin/auth/passkey/register` — admin session, `account.self_manage`: complete passkey registration for the signed-in user
- `POST /admin/auth/password/change` — admin session, `account.self_manage`: change the authenticated admin user's own password with `{current_password, new_password, confirm_password}`
- `POST /admin/auth/password/request` — public: request a one-hour reset link by username or email
- `POST /admin/auth/password/reset` — public: consume a reset token with `{token, new_password, confirm_password}`
- `GET /admin/passkeys` — admin session, `account.self_manage`: list the signed-in user passkeys
- `POST /admin/passkeys/{id}/name` — admin session, `account.self_manage`: rename a passkey
- `DELETE /admin/passkeys/{id}` — admin session, `account.self_manage`: delete a passkey
- `GET /admin/users` — admin session, `users.read`: list admin users
- `GET /admin/setup/status` — public until the first owner exists, then admin session, `settings.read`: setup state and secret-free infrastructure checks
- `POST /admin/setup/owner` — public until the first owner exists, then admin session, `users.manage`: claim the first owner account (one-time)
- `GET /admin/setup/wizard` — public until the first owner exists, then admin session, `settings.read`: read first-run wizard progress
- `POST /admin/setup/wizard` — public until the first owner exists, then admin session, `settings.manage`: update first-run wizard progress
- `POST /admin/users` — public until the first owner exists, then admin session, `users.manage`: create admin user
- `POST /admin/users/{id}` — admin session, `users.manage`: update admin user
- `DELETE /admin/users/{id}` — admin session, `users.manage`: delete admin user (blocked if last active admin)
- `POST /admin/users/wipe` — admin session, `users.manage`: wipe all admin users (requires confirmation `confirm:"WIPE"`)
- `POST /admin/auth/upload` — admin session, `auth.manage`: admin upload/seed canonical `auth.json` (JSON body or `file`)
- `POST /admin/auth/seed-command` — admin session, `auth.manage`: issue a one-time seed command for an engine
- `GET /admin/authorization` — admin session, `security.manage_authorization`: read the authorization mode (`{mode: "compatible"|"strict"}`)
- `POST /admin/authorization` — admin session, `security.manage_authorization`: set the authorization mode (`{mode: "compatible"|"strict"}`)
- `GET /admin/*` — public: static SPA bundle, HTML fallback and manual assets (static mount, no route handler)

## Admin: dashboard, settings and fleet policy

Default spec section: [Admin (admin session cookie)](interface-api.md#admin-admin-session-cookie); lines with another section link it.

- `GET /admin/overview` — admin session, `admin.read`: dashboard overview snapshot (hosts, versions, quota and usage summary)
- `GET /admin/ws/info` — admin session, `admin.read`: websocket bootstrap (`enabled`, `url`, `last_event_id`, `heartbeat_seconds`, `backlog_limit`)
- `POST /admin/toasts` — admin session, `settings.manage`: emit admin toast event
- `GET /admin/model-defaults/{engine}` — admin session, `settings.read`: read the `codex`, `claude`, or `grok` fleet CLI default
- `POST /admin/model-defaults/{engine}` — admin session, `settings.manage`: strict body `{model, reasoning_effort?: string|null}`
- `GET /admin/quota-mode` — admin session, `settings.read`: read `quota_hard_fail`, `limit_percent` (`50..100`), `week_partition` (`off|7|5`) ([spec](interface-api.md#provider-quota-recommendation))
- `POST /admin/quota-mode` — admin session, `settings.manage`: set `quota_hard_fail`, `limit_percent` (`50..100`), `week_partition` (`off|7|5`) ([spec](interface-api.md#provider-quota-recommendation))
- `GET /admin/cdx-silent` — admin session, `settings.read`: read wrapper silent mode (`silent` boolean)
- `POST /admin/cdx-silent` — admin session, `settings.manage`: set wrapper silent mode (`silent` boolean)
- `GET /admin/subagent-model-selection` — admin session, `settings.read`: read the default-off subagent model selection guidance (`enabled` boolean)
- `POST /admin/subagent-model-selection` — admin session, `settings.manage`: set the default-off subagent model selection guidance (`enabled` boolean)
- `GET /admin/model-tier-check` — admin session, `settings.read`: read the default-on cross-engine Model Class Check (`enabled` boolean)
- `POST /admin/model-tier-check` — admin session, `settings.manage`: set the default-on cross-engine Model Class Check (`enabled` boolean)
- `GET /admin/api-keys-in-chat` — admin session, `settings.read`: read the default-off cross-engine instruction for operator-supplied API keys (`enabled` boolean)
- `POST /admin/api-keys-in-chat` — admin session, `settings.manage`: set the default-off cross-engine instruction for operator-supplied API keys (`enabled` boolean)
- `GET /admin/agents-generation-mode` — admin session, `settings.read`: read the fleet-wide master switch for AGENTS.md/CLAUDE.md generation
- `POST /admin/agents-generation-mode` — admin session, `settings.manage`: set the fleet-wide master switch for AGENTS.md/CLAUDE.md generation
- `GET /admin/auto-update` — admin session, `settings.read`: read the fleet auto-update flag (`enabled` boolean)
- `POST /admin/auto-update` — admin session, `settings.manage`: set the fleet auto-update flag (`enabled` boolean)
- `GET /admin/theme` — admin session, `admin.read`: read the stored admin UI theme (`auto` default)
- `POST /admin/theme` — admin session, `settings.manage`: set the stored admin UI theme (`auto` default)
- `GET /admin/reverse-dns` — admin session, `settings.read`: read global reverse DNS enforcement (`enabled` boolean)
- `POST /admin/reverse-dns` — admin session, `settings.manage`: set global reverse DNS enforcement (`enabled` boolean)
- `GET /admin/response-verbosity` — admin session, `settings.read`: read the fleet-wide response-verbosity dial (`level`: `0..4`, `0` default/no-op)
- `POST /admin/response-verbosity` — admin session, `settings.manage`: set the fleet-wide response-verbosity dial (`level`: `0..4`, `0` default/no-op)
- `GET /admin/address-form` — admin session, `settings.read`: read the fleet-wide formal/informal address form (`form`: `informal` default, `formal`)
- `POST /admin/address-form` — admin session, `settings.manage`: set the fleet-wide formal/informal address form (`form`: `informal` default, `formal`)
- `GET /admin/prune-policy` — admin session, `settings.read`: read the inactivity prune window
- `GET /admin/settings/host-overrides` — admin session, `settings.read`: list hosts that override fleet settings
- `POST /admin/prune-policy` — admin session, `settings.manage`: set inactivity prune days `{inactivity_days:0..60}`
- `GET /admin/logs` — admin session, `audit.read`: recent audit events
- `GET /admin/manual/manifest` — admin session, `admin.read`: in-app manual manifest
- `GET /admin/manual/search` — admin session, `admin.read`: search the in-app manual
- `GET /admin/manual/article/{slug}` — admin session, `admin.read`: read one manual article
- `GET /admin/session-housekeeping` — admin session, `settings.read`: read fleet housekeeping rules per engine ([spec](interface-api.md#local-session-housekeeping))
- `POST /admin/session-housekeeping/{engine}` — admin session, `settings.manage`: save the fleet housekeeping rule for an engine ([spec](interface-api.md#local-session-housekeeping))
- `GET /admin/model-policy/{engine}` — admin session, `settings.read`: read the engine catalog filter policy ([spec](interface-api.md#fleet-model-policy))
- `PUT /admin/model-policy/{engine}` — admin session, `settings.manage`: set the engine catalog filter policy ([spec](interface-api.md#fleet-model-policy))
- `GET /admin/quota-policy/{engine}` — admin session, `settings.read`: read the engine quota-policy defaults ([spec](interface-api.md#account-quota-warnings-and-reset-recovery-cxx-09112))
- `PUT /admin/quota-policy/{engine}` — admin session, `settings.manage`: set the engine quota-policy defaults ([spec](interface-api.md#account-quota-warnings-and-reset-recovery-cxx-09112))
- `GET /admin/server-retention` — admin session, `settings.read`: effective server-history policy, revision and bounded cleanup status ([spec](interface-api.md#server-history-retention))
- `POST /admin/server-retention` — admin session, `settings.manage`: save validated policy with expected revision (`settings.manage`) ([spec](interface-api.md#server-history-retention))
- `POST /admin/server-retention/preview` — admin session, `settings.read`: read-only saved-policy eligibility observation (`settings.read`) ([spec](interface-api.md#server-history-retention))
- `POST /admin/server-retention/run` — admin session, `settings.manage`: request an idempotent guarded cleanup using a client UUID and expected revision ([spec](interface-api.md#server-history-retention))
- `GET /admin/server-retention/runs/{id}` — admin session, `settings.read`: current retained run status, or 404 after replacement ([spec](interface-api.md#server-history-retention))
- `GET /admin/rtk` — admin session, `settings.read`: per-engine fleet defaults ([spec](interface-api.md#rtk-policy-and-readiness-api))
- `POST /admin/rtk/{engine}` — admin session, `settings.manage`: save `{enabled:boolean}` (settings.manage) ([spec](interface-api.md#rtk-policy-and-readiness-api))
- `GET /admin/speech-input` — admin session, `settings.read`: per-engine speech input policy `{engines:{<engine>:{enabled, override, global, supported, activation, control}}}` ([spec](interface-api.md#native-speech-input-policy))
- `POST /admin/speech-input/{target}` — admin session, `settings.manage`: `target` is `global` or an engine ([spec](interface-api.md#native-speech-input-policy))
- `GET /admin/ws` — admin session, `admin.read`: admin WebSocket upgrade for live updates (registered by `api/src/ws/server.ts`)

## Admin: hosts, versions and rollout

Default spec section: [Admin (admin session cookie)](interface-api.md#admin-admin-session-cookie); lines with another section link it.

- `POST /admin/hosts/{id}/insecure/enable` — admin session, `hosts.activate_insecure`: open or extend a host insecure window (insecure hosts only)
- `PUT /admin/hosts/{id}/agents-extra` — admin session, `hosts.manage`: set the per-host extra AGENTS text
- `POST /admin/hosts/register` — admin session, `hosts.security_transition`: mint a host and single-use installer (owner/admin; the same FQDN again rotates its key)
- `POST /admin/hosts/quick-register` — admin session, `hosts.manage`: create an insecure temporary throwaway host with an auto-generated short `tmp-YYYYMMDD-HHMMSS-xxxxxx`
- `POST /admin/versions/check` — admin session, `settings.manage`: force fresh GitHub release lookup (bypass cache) and return `{available_client, versions}`
- `POST /admin/codex-version` — admin session, `settings.manage`: set fleet Codex version policy
- `GET /admin/hosts` — admin session, `hosts.read`: list hosts with digest/history, versions, API calls, IPs, roaming flag, `secure`, `vip`
- `GET /admin/hosts/insecure` — admin session, `hosts.read`: insecure-host view with `{count, active, hosts[], domains[], domains_active, fleet_window}`
- `GET /admin/hosts/{id}/detail` — admin session, `hosts.read`: single-host detail card: the host row plus per-engine version summaries, available client versions
- `POST /admin/hosts/{id}/installer` — admin session, `hosts.manage`: mint a fresh single-use installer for an existing host
- `POST /admin/hosts/{id}/engines` — admin session, `hosts.security_transition`: set the host's enabled engines (`engines`, at least one of `codex` / `claude` / `grok`)
- `POST /admin/hosts/{id}/release-ip-binding` — admin session, `hosts.manage`: clear the pinned `ip4`/`ip6` so the next authenticated request re-pins
- `POST /admin/hosts/{id}/auto-update` — admin session, `hosts.manage`: set the per-host auto-update override
- `POST /admin/hosts/{id}/browseros-mcp` — admin session, `hosts.manage`: toggle the BrowserOS MCP server in the host's baked config (`browseros_mcp` boolean)
- `POST /admin/hosts/{id}/roaming` — admin session, `hosts.manage`: toggle `allow_roaming_ips` (`allow` boolean)
- `POST /admin/hosts/{id}/secure` — admin session, `hosts.security_transition`: toggle secure/insecure mode
- `GET /admin/wrapper/rollout` — admin session, `hosts.read`: staged cxx rollout status (`hosts.read`): `enabled` (the effective switch)
- `GET /admin/wrapper/rollout/enabled` — admin session, `hosts.read`: `{enabled, source}` of the rollout switch (`hosts.read`)
- `POST /admin/wrapper/rollout/enabled` — admin session, `hosts.manage`: enable or disable staged wrapper rollout
- `POST /admin/wrapper/rollout/{action}` — admin session, `hosts.manage`: `halt` (optional `reason`), `resume` (restarts the current stage's soak)
- `POST /admin/hosts/{id}/wrapper-canary` — admin session, `hosts.manage`: mark or unmark a host as wrapper canary
- `POST /admin/hosts/{id}/vip` — admin session, `hosts.manage`: toggle VIP (VIP hosts always behave warn-only for quota hard-fail)
- `POST /admin/hosts/{id}/curl-insecure` — admin session, `hosts.manage`: toggle sync TLS verification bypass (`allow` boolean)
- `POST /admin/hosts/{id}/reverse-dns` — admin session, `hosts.manage`: set per-host reverse DNS mode (`mode`: `global` | `enabled` | `disabled`)
- `POST /admin/hosts/{id}/model` — admin session, `hosts.manage`: set per-host Codex `model_override` / `reasoning_effort_override`, Claude `claude_model_override` ([spec](interface-api.md#native-model-version-metadata))
- `POST /admin/hosts/{id}/codex-version` — admin session, `hosts.manage`: set per-host Codex version override (`selection: "global"|"fleet"|"default"|"<x.y.z>"`)
- `POST /admin/hosts/{id}/claude-version` — admin session, `hosts.manage`: set per-host Claude Code version override
- `GET /admin/hosts/{id}/agents-extra` — admin session, `hosts.read`: read the per-host extra AGENTS text
- `POST /admin/hosts/{id}/agents-version` — admin session, `hosts.manage`: set per-host AGENTS document override (`selection: "global"|"fleet"|"default"|<version_id>`)
- `POST /admin/hosts/{id}/insecure/disable` — admin session, `hosts.activate_insecure`: closes window immediately and clears grace
- `POST /admin/hosts/insecure/extend` — admin session, `hosts.activate_insecure`: for active insecure hosts, resets each active window to `now + insecure_window_minutes`
- `POST /admin/hosts/insecure/disable-all` — admin session, `hosts.activate_insecure`: closes all active insecure windows, expires active domain auto-allows
- `POST /admin/hosts/insecure/window` — admin session, `hosts.activate_insecure`: open the fleet-wide insecure window
- `POST /admin/hosts/insecure/window/close` — admin session, `hosts.activate_insecure`: close the fleet window: clears every insecure host's window and grace
- `GET /admin/insecure-approval` — admin session, `settings.read`: read insecure approval gate (`enabled` boolean)
- `POST /admin/insecure-approval` — admin session, `settings.manage`: set insecure approval gate (`enabled` boolean)
- `GET /admin/insecure-approvals/pending` — admin session, `hosts.read`: list unresolved insecure approval requests for the admin queue
- `POST /admin/insecure-approvals/{id}/allow-domain` — admin session, `hosts.activate_insecure`: approve pending request and add/update a domain auto-allow
- `POST /admin/insecure-approvals/{id}/approve` — admin session, `hosts.activate_insecure`: approve pending request and open host window
- `POST /admin/insecure-approvals/{id}/deny` — admin session, `hosts.activate_insecure`: deny pending request
- `POST /admin/insecure-domain-allows/{id}/revoke` — admin session, `hosts.activate_insecure`: revoke domain auto-allow
- `DELETE /admin/hosts/{id}` — admin session, `hosts.security_transition`: delete host + digests
- `GET /admin/communicator/api-version` — admin session, `settings.read`: communicator API level state (current, minimum, override, clients) ([spec](interface-api.md#communicator-api-level))
- `POST /admin/communicator/api-version` — admin session, `settings.manage`: raise or clear the operator minimum ([spec](interface-api.md#communicator-api-level))
- `GET /admin/runner` — admin session, `admin.read`: runner config/telemetry
- `POST /admin/runner/run` — admin session, `auth.manage`: force Codex runner validation
- `POST /admin/runner/run-claude` — admin session, `auth.manage`: force Claude runner validation
- `POST /admin/runner/run-grok` — admin session, `auth.manage`: read-only Grok subscription verification ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/hosts/{id}/grok-version` — admin session, `hosts.manage`: set/clear a host-specific Grok CLI pin ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/hosts/{id}/kimi-version` — admin session, `hosts.manage`: set/clear a host-specific Kimi CLI pin ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/runner/run-kimi` — admin session, `auth.manage`: read-only Kimi subscription verification ([spec](interface-api.md#kimi-code-admin-api))
- `GET /admin/host-daemons` — admin session, `admin.read`: list host daemons ([spec](interface-api.md#daemon-http-surfaces))
- `GET /admin/hosts/{id}/daemon` — admin session, `admin.read`: read one host daemon ([spec](interface-api.md#remote-daemon-route-inventory))
- `PUT /admin/hosts/{id}/daemon` — admin session, `agent_messaging.manage`: set one host daemon ([spec](interface-api.md#remote-daemon-route-inventory))
- `GET /admin/hosts/{id}/session-housekeeping` — admin session, `hosts.read`: read effective housekeeping rules for a host ([spec](interface-api.md#local-session-housekeeping))
- `POST /admin/hosts/{id}/session-housekeeping/{engine}` — admin session, `hosts.manage`: save a host housekeeping rule or reset it to inherit ([spec](interface-api.md#local-session-housekeeping))
- `GET /admin/host-spawn/state` — admin session, `admin.read`: read the global host-spawn switch ([spec](interface-api.md#system-spawn-new-system-provisioning))
- `POST /admin/host-spawn/state` — admin session, `settings.manage`: set the global host-spawn switch ([spec](interface-api.md#system-spawn-new-system-provisioning))
- `GET /admin/topology` — admin session, `hosts.read`: live connection tree: server, communicators, agent sessions ([spec](interface-api.md#live-topology-endpoints))
- `POST /admin/communicators/{id}/disconnect` — admin session, `agent_portal.manage`: close one communicator socket ([spec](interface-api.md#live-topology-endpoints))
- `POST /admin/communicators/{id}/terminate` — admin session, `agent_portal.manage`: ask a communicator owner process to stop ([spec](interface-api.md#live-topology-endpoints))
- `GET /admin/communicators` — admin session, `hosts.read`: live communicator connections ([spec](interface-api.md#communicator-transport-endpoints))
- `GET /admin/hosts/{id}/rtk` — admin session, `hosts.read`: per-engine effective policies, overrides and dated readiness ([spec](interface-api.md#rtk-policy-and-readiness-api))
- `POST /admin/hosts/{id}/rtk/{engine}` — admin session, `hosts.manage`: save `{enabled:boolean|null}` (hosts.manage) ([spec](interface-api.md#rtk-policy-and-readiness-api))

## Admin: engines, accounts and gateway keys

Default spec section: [Admin (admin session cookie)](interface-api.md#admin-admin-session-cookie); lines with another section link it.

- `POST /admin/api/state` — admin session, `settings.manage`: set the API kill switch
- `POST /admin/api/surfaces/{surface}` — admin session, `settings.manage`: set a surface backend and disabled flag ([spec](interface-api.md#exposed-api-routing-any-to-any))
- `GET /admin/api/state` — admin session, `settings.read`: read the API kill switch
- `GET /admin/api/surfaces` — admin session, `settings.read`: list exposed API surfaces with backend, kill switch and active key count
- `GET /admin/engines/active` — admin session, `admin.read`: engines currently active fleet-wide (needs `admin.read`) ([spec](interface-api.md#engine-master-switches))
- `GET /admin/engines/state` — admin session, `settings.read`: fleet-wide engine master switches
- `POST /admin/engines/{engine}/state` — admin session, `settings.manage`: switch one engine on or off fleet-wide ([spec](interface-api.md#engine-master-switches))
- `GET /admin/engines/{engine}/destroy` — admin session, `settings.read`: destroy-engine progress
- `POST /admin/engines/{engine}/destroy` — admin session, `settings.manage`: open a destroy-engine request (engine must be suspended; confirm by engine name) ([spec](interface-api.md#engine-destroy))
- `POST /admin/engines/{engine}/destroy/purge` — admin session, `settings.manage`: purge the destroyed engine's stored auth payloads and related records
- `DELETE /admin/engines/{engine}/destroy` — admin session, `settings.manage`: cancel the open destroy-engine request
- `GET /admin/openai/keys` — admin session, `auth.read_metadata`: list gateway keys (no key material)
- `POST /admin/openai/keys` — admin session, `keys.manage`: issue a gateway key (full key returned once)
- `POST /admin/openai/keys/{id}/toggle` — admin session, `keys.manage`: enable/disable a key (`active` boolean)
- `DELETE /admin/openai/keys/{id}` — admin session, `keys.manage`: delete a gateway key
- `GET /admin/claude/keys` — admin session, `auth.read_metadata`: list all Claude API keys (engine-filtered)
- `POST /admin/claude/keys` — admin session, `keys.manage`: create a new Claude API key
- `POST /admin/claude/keys/{id}/toggle` — admin session, `keys.manage`: enable or disable a Claude API key
- `DELETE /admin/claude/keys/{id}` — admin session, `keys.manage`: revoke (delete) a Claude API key
- `GET /admin/claude/settings` — admin session, `content.read`: get the separate Anthropic-compatible API proxy defaults
- `POST /admin/claude/version` — admin session, `settings.manage`: set the fleet Claude Code version policy
- `GET /admin/claude/config` — admin session, `content.read`: claude `settings.json` builder state (stored sub-blocks plus the baked document)
- `POST /admin/claude/config/render` — admin session, `content.read`: render `{settings}` to the baked `settings.json` without storing it
- `POST /admin/claude/config/store` — admin session, `content.manage`: store `{settings}` (optional `sha256` for compare-and-swap) as the served Claude config
- `GET /admin/claude/{kind}` — admin session, `content.read`: list Claude artifacts of `kind` (`subagent` | `command` | `output-style`), deleted entries included
- `GET /admin/claude/{kind}/{slug}` — admin session, `content.read`: one artifact with its frontmatter and body
- `POST /admin/claude/{kind}/store` — admin session, `content.manage`: create/update an artifact
- `DELETE /admin/claude/{kind}/{slug}` — admin session, `content.manage`: soft-delete an artifact so hosts retrieve `status:deleted`
- `POST /admin/claude/settings` — admin session, `content.manage`: update the separate Anthropic-compatible API proxy defaults
- `GET /admin/accounts` — admin session, `auth.read_metadata`: session-gated metadata list: `accounts[]` with `id`, `engine`, `label`, lifecycle state ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `POST /admin/accounts` — admin session, `auth.manage`: add a provider account from a credential payload ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `PATCH /admin/accounts/{id}` — admin session, `auth.manage`: relabel, enable or pause an account ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `POST /admin/accounts/{id}/credentials` — admin session, `auth.manage`: replace the stored credentials of an account ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `POST /admin/accounts/{id}/verify` — admin session, `auth.manage`: live runner verification ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `DELETE /admin/accounts/{id}` — admin session, `auth.manage`: stops new assignments immediately (`removing`) ([spec](interface-api.md#provider-accounts-and-launch-reservations))
- `GET /admin/accounts/policy/{engine}` — admin session, `auth.read_metadata`: read the account distribution policy ([spec](interface-api.md#claude-multiple-accounts-and-live-switching))
- `POST /admin/accounts/policy/{engine}` — admin session, `auth.manage`: change mode, strategy, band and ceilings ([spec](interface-api.md#claude-multiple-accounts-and-live-switching))
- `GET /admin/accounts/scopes` — admin session, `auth.read_metadata`: running scopes with bound account, generation and pending switch ([spec](interface-api.md#claude-multiple-accounts-and-live-switching))
- `POST /admin/accounts/scopes/switch` — admin session, `auth.manage`: request a live switch of one scope ([spec](interface-api.md#claude-multiple-accounts-and-live-switching))
- `GET /admin/grok/keys` — admin session, `auth.read_metadata`: list Grok gateway keys without credential bodies ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/grok/keys` — admin session, `keys.manage`: issue a scoped sk-cgx- gateway key, returned once ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/grok/keys/{id}/toggle` — admin session, `keys.manage`: change a Grok gateway key active state ([spec](interface-api.md#grok-endpoint-inventory))
- `DELETE /admin/grok/keys/{id}` — admin session, `keys.manage`: remove a Grok gateway key ([spec](interface-api.md#grok-endpoint-inventory))
- `GET /admin/grok/settings` — admin session, `content.read`: read gateway default_model and disabled ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/grok/settings` — admin session, `content.manage`: change gateway default model/switch ([spec](interface-api.md#grok-endpoint-inventory))
- `GET /admin/grok/models` — admin session, `content.read`: list native catalog with enabled flags ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/grok/models/{model}/toggle` — admin session, `content.manage`: enable/disable a Grok gateway model ([spec](interface-api.md#grok-endpoint-inventory))
- `GET /admin/grok/config` — admin session, `content.read`: read engine-specific managed config metadata ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/grok/config/render` — admin session, `content.read`: preview native TOML config ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/grok/config/store` — admin session, `content.manage`: save managed Grok config ([spec](interface-api.md#grok-endpoint-inventory))
- `POST /admin/grok/version` — admin session, `settings.manage`: set/clear the independent exact CLI pin ([spec](interface-api.md#grok-endpoint-inventory))
- `GET /admin/kimi/keys` — admin session, `auth.read_metadata`: list Kimi gateway keys without credential bodies ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/kimi/keys` — admin session, `keys.manage`: issue a scoped sk-ckx- gateway key, returned once ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/kimi/keys/{id}/toggle` — admin session, `keys.manage`: change a Kimi gateway key active state ([spec](interface-api.md#kimi-code-admin-api))
- `DELETE /admin/kimi/keys/{id}` — admin session, `keys.manage`: remove a Kimi gateway key ([spec](interface-api.md#kimi-code-admin-api))
- `GET /admin/kimi/settings` — admin session, `content.read`: read gateway default_model and disabled ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/kimi/settings` — admin session, `content.manage`: change gateway default model/switch ([spec](interface-api.md#kimi-code-admin-api))
- `GET /admin/kimi/models` — admin session, `content.read`: list native catalog with enabled flags ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/kimi/models/{model}/toggle` — admin session, `content.manage`: enable/disable a Kimi gateway model ([spec](interface-api.md#kimi-code-admin-api))
- `GET /admin/kimi/config` — admin session, `content.read`: read engine-specific managed config metadata ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/kimi/config/render` — admin session, `content.read`: preview native TOML config ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/kimi/config/store` — admin session, `content.manage`: save managed Kimi config ([spec](interface-api.md#kimi-code-admin-api))
- `POST /admin/kimi/version` — admin session, `settings.manage`: set/clear the independent exact CLI pin ([spec](interface-api.md#kimi-code-admin-api))
- `GET /admin/accounts/{id}/quota-policy` — admin session, `auth.read_metadata`: read an account quota-policy override ([spec](interface-api.md#account-quota-warnings-and-reset-recovery-cxx-09112))
- `PUT /admin/accounts/{id}/quota-policy` — admin session, `auth.manage`: set an account quota-policy override ([spec](interface-api.md#account-quota-warnings-and-reset-recovery-cxx-09112))

## Admin: skills, agent documents, config, memories and secrets

Default spec section: [Admin (admin session cookie)](interface-api.md#admin-admin-session-cookie); lines with another section link it.

- `GET /admin/skills` — admin session, `content.read`: list stored skills
- `GET /admin/skills/{slug}` — admin session, `content.read`: read one skill
- `POST /admin/skills/generate` — admin session, `content.manage`: admin-only runner-backed draft generation
- `POST /admin/skills/assist` — admin session, `content.manage`: admin-only runner-backed conversational draft refinement
- `POST /admin/skills/store` — admin session, `content.manage`: create/update a skill
- `DELETE /admin/skills/{slug}` — admin session, `content.manage`: retire a locally authored skill
- `GET /admin/skill-sources/mattpocock` — admin session, `content.read`: matt Pocock skill source state
- `POST /admin/skill-sources/mattpocock` — admin session, `content.manage`: enable the source or toggle auto-update (owner/admin only)
- `POST /admin/skill-sources/mattpocock/refresh` — admin session, `content.manage`: force an immediate source check (owner/admin only)
- `GET /admin/agents` — admin session, `content.read`: fetch AGENTS.md serving state for the dashboard
- `GET /admin/agents/render` — admin session, `content.read`: read-only preview of the exact current document the selected host would receive
- `POST /admin/agents/compose` — admin session, `content.read`: normalize a toggle-builder composition and render its canonical base document without storing
- `POST /admin/agents/render` — admin session, `content.read`: render an unsaved raw or composed draft through the exact host- and engine-specific managed renderer
- `GET /admin/agents/versions/{id}` — admin session, `content.read`: fetch one historical AGENTS.md version with full `content`, `sha256`, timestamps, `size_bytes`
- `POST /admin/agents/store` — admin session, `content.manage`: create a new AGENTS.md edition
- `POST /admin/agents/serve` — admin session, `content.manage`: set the serving mode
- `POST /admin/agents/revert` — admin session, `content.manage`: create a new latest AGENTS.md edition by cloning a historical version
- `POST /admin/agents/retention` — admin session, `content.manage`: set AGENTS historical backup retention
- `DELETE /admin/agents/versions/{id}` — admin session, `content.manage`: delete a non-served AGENTS.md edition by id
- `GET /admin/agent-policy-profiles` — admin session, `content.read`: list named fleet security postures with their assigned host ids
- `POST /admin/agent-policy-profiles` — admin session, `content.manage`: create a profile
- `POST /admin/agent-policy-profiles/{id}` — admin session, `content.manage`: update a profile's `name`, `description`, or `levels`
- `DELETE /admin/agent-policy-profiles/{id}` — admin session, `content.manage`: delete a profile and every host assignment pointing at it
- `POST /admin/agent-policy-profiles/{id}/default` — admin session, `content.manage`: make this profile the fleet default, clearing the flag from whichever profile held it
- `POST /admin/agent-policy-profiles/assign` — admin session, `content.manage`: assign a host to a profile
- `GET /admin/agent-policy-profiles/enforcement` — admin session, `content.read`: read-only projection of a host's resolved posture onto engine config
- `GET /admin/memories/graph` — admin session, `memory.read`: cross-scope memory graph
- `GET /admin/memories/audit` — admin session, `audit.read`: memory audit trail
- `GET /admin/memories/{scope}/{recordId}` — admin session, `memory.read`: one memory record
- `POST /admin/memories/{scope}` — admin session, `memory.write`: create a record
- `POST /admin/memories/shared/{recordId}/append` — admin session, `memory.write`: append to a shared memory
- `POST /admin/memories/shared/{recordId}/restore` — admin session, `memory.write`: undo one replace: `{revision, expected_etag}` (or `If-Match`) writes back the body that revision
- `PATCH /admin/memories/{scope}/{recordId}` — admin session, `memory.write`: update a record
- `DELETE /admin/memories/{scope}/{recordId}` — admin session, `memory.write`: delete a record
- `GET /admin/secrets/state` — admin session, `secrets.read_metadata`: module switch plus a live secret count
- `POST /admin/secrets/state` — admin session, `secrets.manage`: flip the secrets module switch
- `GET /admin/secrets` — admin session, `secrets.read_metadata`: metadata listing
- `GET /admin/secrets/{id}` — admin session, `secrets.read_metadata`: one secret's metadata
- `POST /admin/secrets` — admin session, `secrets.manage`: create a secret
- `PATCH /admin/secrets/{id}` — admin session, `secrets.manage`: update a secret (`slug` is immutable)
- `DELETE /admin/secrets/{id}` — admin session, `secrets.manage`: soft-delete a secret (effective on the next `secret_get`)
- `POST /admin/secrets/{id}/reveal` — admin session, `secrets.reveal`: the only endpoint that returns a plaintext value
- `GET /admin/config` — admin session, `content.read`: fetch saved Codex configuration metadata, historical `content` and normalized `settings`
- `POST /admin/config/render` — admin session, `content.read`: validate and render a `settings` payload into TOML without persisting it
- `POST /admin/config/store` — admin session, `content.manage`: persist validated canonical Codex configuration built from `settings`

## Admin: projects and CoCo

Default spec section: [Admin (admin session cookie)](interface-api.md#admin-admin-session-cookie); lines with another section link it.

- `GET /admin/projects/state` — admin session, `projects.read`: projects module state and managed skill
- `POST /admin/projects/state` — admin session, `projects.manage`: set the projects module switch
- `GET /admin/projects/feedback` — admin session, `projects.read`: list feedback across all projects
- `GET /admin/projects` — admin session, `projects.read`: list projects
- `POST /admin/projects` — admin session, `projects.manage`: create a project
- `GET /admin/projects/{slug}` — admin session, `projects.read`: read one project with its files
- `DELETE /admin/projects/{slug}` — admin session, `projects.manage`: hard-delete a project and its dependent records
- `POST /admin/projects/{slug}/assist` — admin session, `projects.manage`: admin-only runner-backed project metadata draft
- `GET /admin/projects/{slug}/summary` — admin session, `projects.read`: counts and about block without file bodies
- `POST /admin/projects/{slug}/archive` — admin session, `projects.manage`: archive a project
- `POST /admin/projects/{slug}/unarchive` — admin session, `projects.manage`: unarchive a project
- `POST /admin/projects/{slug}/about` — admin session, `projects.manage`: edit the project about block
- `POST /admin/projects/{slug}/roster` — admin session, `projects.manage`: edit the project roster
- `GET /admin/projects/{slug}/changes` — admin session, `projects.read`: project change log
- `GET /admin/projects/{slug}/files/{id}` — admin session, `projects.read`: read one project file
- `POST /admin/projects/{slug}/feedback/{id}` — admin session, `projects.manage`: update one project feedback item
- `GET /admin/projects/{slug}/notes` — admin session, `projects.read`: list project notes
- `POST /admin/projects/{slug}/notes` — admin session, `projects.manage`: create a project note
- `POST /admin/projects/{slug}/notes/{id}` — admin session, `projects.manage`: update a project note
- `DELETE /admin/projects/{slug}/notes/{id}` — admin session, `projects.manage`: delete a project note
- `GET /admin/project-changelog` — admin session, `projects.read`: cross-project changelog timeline ([spec](interface-api.md#project-changelog))
- `GET /admin/project-changelog/state` — admin session, `projects.read`: read the fleet project-changelog switch ([spec](interface-api.md#project-changelog))
- `POST /admin/project-changelog/state` — admin session, `projects.manage`: set the fleet project-changelog switch ([spec](interface-api.md#project-changelog))
- `GET /admin/projects/{slug}/changelog` — admin session, `projects.read`: list or search one project's changelog ([spec](interface-api.md#project-changelog))
- `POST /admin/projects/{slug}/changelog` — admin session, `projects.manage`: append an operator changelog entry ([spec](interface-api.md#project-changelog))
- `POST /admin/projects/{slug}/changelog/{id}` — admin session, `projects.manage`: edit any changelog entry ([spec](interface-api.md#project-changelog))
- `DELETE /admin/projects/{slug}/changelog/{id}` — admin session, `projects.manage`: delete any changelog entry ([spec](interface-api.md#project-changelog))
- `GET /admin/projects/{slug}/files` — admin session, `projects.read`: list project files
- `POST /admin/projects/{slug}/files` — admin session, `projects.manage`: upload a project file
- `DELETE /admin/projects/{slug}/files/{id}` — admin session, `projects.manage`: delete one project file
- `GET /admin/projects/{slug}/feedback` — admin session, `projects.read`: list project feedback
- `POST /admin/projects/{slug}/feedback` — admin session, `projects.manage`: create project feedback
- `GET /admin/projects/{slug}/slop-jobs` — admin session, `projects.read`: list a project slop jobs ([spec](interface-api.md#slop-jobs))
- `GET /admin/projects/{slug}/slop-jobs/{id}` — admin session, `projects.read`: one slop job with files and runs ([spec](interface-api.md#slop-jobs))
- `GET /admin/slop-jobs/state` — admin session, `projects.read`: read the fleet slop-jobs switch ([spec](interface-api.md#slop-jobs))
- `POST /admin/slop-jobs/state` — admin session, `projects.manage`: set the fleet slop-jobs switch ([spec](interface-api.md#slop-jobs))
- `GET /admin/project-board/state` — admin session, `projects.read`: module switch plus live board, card and held-claim counts
- `POST /admin/project-board/state` — admin session, `projects.manage`: flip the project board switch
- `GET /admin/projects/{slug}/board` — admin session, `projects.read`: the board: its lanes with their WIP limits and role gates, the cards in each
- `POST /admin/projects/{slug}/board/cards` — admin session, `projects.manage`: create a board card
- `POST /admin/projects/{slug}/board/cards/{id}` — admin session, `projects.manage`: update a board card in place
- `POST /admin/projects/{slug}/board/cards/{id}/move` — admin session, `projects.manage`: move a board card to another column
- `POST /admin/projects/{slug}/board/cards/{id}/release` — admin session, `projects.manage`: take a card claim back on the operator behalf
- `DELETE /admin/projects/{slug}/board/cards/{id}` — admin session, `projects.manage`: archive a board card (its events keep a row)

## Admin: agent sessions, messaging and chat

Default spec section: [Agent Messaging](interface-api.md#agent-messaging); lines with another section link it.

- `GET /admin/agent-messaging/groups` — admin session, `agent_messaging.read`: list group metadata (`agent_messaging.read`)
- `POST /admin/agent-messaging/groups` — admin session, `agent_messaging.manage`: create a group (`agent_messaging.manage`)
- `GET /admin/agent-messaging/groups/{slug}` — admin session, `agent_messaging.read`: inspect group members (`agent_messaging.read`)
- `DELETE /admin/agent-messaging/groups/{slug}` — admin session, `agent_messaging.manage`: delete any empty group and free its slug
- `GET /admin/agent-messaging/subscriptions` — admin session, `agent_messaging.read`: inspect subscription metadata (`agent_messaging.read`)
- `POST /admin/agent-messaging/publish` — admin session, `agent_messaging.manage`: publish as Server to a group or the Server feed
- `GET /admin/agent-messaging/state` — admin session, `agent_messaging.read`: global state, queue/address counts, and the four direction summaries
- `POST /admin/agent-messaging/state` — admin session, `agent_messaging.manage`: set the global switch
- `GET /admin/agent-messaging` — admin session, `agent_messaging.read`: address inventory compatibility/SPA route
- `GET /admin/agent-messaging/addresses` — admin session, `agent_messaging.read`: stable addresses, host eligibility, readiness, and queue depth
- `PATCH /admin/agent-messaging/addresses/{id}` — admin session, `agent_messaging.manage`: set/clear a unique alias
- `POST /admin/agent-messaging/addresses/{id}/enabled` — admin session, `agent_messaging.manage`: set the address gate
- `GET /admin/agent-messaging/conversations` — admin session, `agent_messaging.read`: metadata listing (`status`, `limit` query filters)
- `POST /admin/agent-messaging/conversations/{id}/cancel` — admin session, `agent_messaging.manage`: cancel a conversation
- `GET /admin/agent-messaging/messages` — admin session, `agent_messaging.read`: metadata-only listing (`conversation_id`, `status`, `limit` query filters)
- `POST /admin/agent-messaging/messages/{id}/reveal` — admin session, `agent_messaging.reveal_content`: owner/admin audited plaintext reveal with `Cache-Control: no-store` and `Pragma: no-cache`
- `POST /admin/agent-messaging/messages/{id}/redrive` — admin session, `agent_messaging.manage`: create a fresh queued message from a `dead` or `ambiguous` original
- `GET /admin/agent-sessions` — admin session, `agent_portal.read`: every wrapper the fleet can see, with derived `presence` (`working`/`listening`/`idle`/`offline`/`ended`) ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/agent-sessions/{id}/events` — admin session, `agent_portal.reveal_transcript`: one session's timeline (`after`, `limit`, `tail`) ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/agent-sessions/events` — admin session, `agent_portal.reveal_transcript`: the fleet-wide event stream as SSE, with `Last-Event-ID` resume ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/agent-sessions/{id}/messages` — admin session, `agent_portal.manage`: queue an operator instruction for a session (202) ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/agent-sessions/{id}/prompts/{promptId}/answer` — admin session, `agent_portal.manage`: answer an open prompt (202) ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/agent-sessions/{id}/close` — admin session, `agent_portal.manage`: queue a cooperative close (202) ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/agent-sessions/{id}/close/force` — admin session, `agent_portal.manage`: end a session immediately, even one that is offline ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/agent-sessions/{id}/receiver/verify` — admin session, `agent_portal.manage`: reconnect the session receiver (the **Reconnect receiver** action) ([spec](interface-api.md#automatic-receiver-protocol-0810))
- `GET /admin/agent-portal/state` — admin session, `agent_portal.read`: switch, configuration, queue health, and dead-letter counts ([spec](interface-api.md#host-registration-and-bridge))
- `POST /admin/agent-portal/state` — admin session, `agent_portal.manage`: toggle the global switch ([spec](interface-api.md#host-registration-and-bridge))
- `POST /admin/agent-messaging/messages/{id}/fresh-start` — admin session, `agent_messaging.manage`: authorize one replacement session after `native_transcript_missing` ([spec](interface-api.md#agent-wake--cron-schedules))
- `POST /admin/daemon-sessions` — admin session, `agent_messaging.manage`: start a daemon session ([spec](interface-api.md#daemon-http-surfaces))
- `GET /admin/daemon-sessions/{id}` — admin session, `agent_portal.reveal_transcript`: read a daemon session ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /admin/daemon-sessions/{id}/messages` — admin session, `agent_messaging.manage`: send a message to a daemon session ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /admin/daemon-sessions/{id}/permission-mode` — admin session, `agent_messaging.manage`: change a daemon session permission mode ([spec](interface-api.md#remote-daemon-route-inventory))
- `POST /admin/daemon-sessions/{id}/stop` — admin session, `agent_messaging.manage`: stop a daemon session ([spec](interface-api.md#remote-daemon-route-inventory))
- `GET /admin/chatty/status` — admin session, `chatty.use`: visibility, provider/engine/model/runner readiness and knowledge digest ([spec](interface-api.md#chatty-personal-product-assistant))
- `GET /admin/chatty/session` — admin session, `chatty.use`: current generation, selection, recent events and active request ([spec](interface-api.md#chatty-personal-product-assistant))
- `PUT /admin/chatty/selection` — admin session, `chatty.use`: set the engine/model selection (each nullable) ([spec](interface-api.md#chatty-personal-product-assistant))
- `POST /admin/chatty/messages` — admin session, `chatty.use`: queue a user message (deduplicated by `client_message_id`) ([spec](interface-api.md#chatty-personal-product-assistant))
- `POST /admin/chatty/runs/{id}/answer` — admin session, `chatty.use`: answer the pending question of a run ([spec](interface-api.md#chatty-personal-product-assistant))
- `POST /admin/chatty/runs/{id}/cancel` — admin session, `chatty.use`: cancel the user request of a run ([spec](interface-api.md#chatty-personal-product-assistant))
- `POST /admin/chatty/actions/{id}/decision` — admin session, `chatty.use`: approve or deny the current proposed action ([spec](interface-api.md#chatty-personal-product-assistant))
- `POST /admin/chatty/proposals/verify` — admin session, `chatty.use`: verify an action-button proposal token ([spec](interface-api.md#chatty-personal-product-assistant))
- `DELETE /admin/chatty/session` — admin session, `chatty.use`: delete the conversation and advance the generation ([spec](interface-api.md#chatty-personal-product-assistant))
- `GET /admin/chatty/events` — admin session, `chatty.use`: personal SSE change notifications ([spec](interface-api.md#chatty-personal-product-assistant))
- `GET /admin/chatty/sources/{id}` — admin session, `chatty.use`: read a source from the private knowledge corpus ([spec](interface-api.md#chatty-personal-product-assistant))
- `GET /admin/chatty/settings` — admin session, `chatty.manage`: installation settings and limits ([spec](interface-api.md#chatty-personal-product-assistant))
- `PUT /admin/chatty/settings` — admin session, `chatty.manage`: set enablement, engine order, concurrency, queue limit, steps and timeout ([spec](interface-api.md#chatty-personal-product-assistant))
- `GET /admin/agent-chat/limits` — admin session, `agent_portal.read`: effective upload limits (admin session) ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /admin/agent-sessions/{id}/attachments` — admin session, `agent_portal.manage`: create/resume upload: {id,name,mime_type,size_bytes,sha256?} ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /admin/agent-sessions/{id}/attachments/{attachmentId}/chunks` — admin session, `agent_portal.manage`: upload {offset,content_b64} ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `POST /admin/agent-sessions/{id}/attachments/{attachmentId}/seal` — admin session, `agent_portal.manage`: seal completed bytes after SHA-256 verification ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `GET /admin/agent-sessions/{id}/attachments/{attachmentId}` — admin session, `agent_portal.reveal_transcript`: attachment name, MIME, size, SHA-256, upload offset and processing status ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `GET /admin/agent-sessions/{id}/attachments/{attachmentId}/content` — admin session, `agent_portal.reveal_transcript`: stream the original or a `?variant=` derivative ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `DELETE /admin/agent-sessions/{id}/attachments/{attachmentId}` — admin session, `agent_portal.manage`: discard the authenticated author's unlinked upload ([spec](interface-api.md#agent-chat-attachments-and-explicit-attention))
- `GET /admin/agent-sessions/{id}/stop` — admin session, `agent_portal.read`: durable result of a session stop ([spec](interface-api.md#live-topology-endpoints))
- `POST /admin/agent-sessions/{id}/stop` — admin session, `agent_portal.manage`: stop an agent session (expected process/binding identity) ([spec](interface-api.md#live-topology-endpoints))
- `GET /admin/roles/state` — admin session, `content.read`: module switch `{enabled}` ([spec](interface-api.md#agent-role-endpoints))
- `POST /admin/roles/state` — admin session, `content.manage`: flip the agent-roles module switch ([spec](interface-api.md#agent-role-endpoints))
- `GET /admin/roles` — admin session, `content.read`: roles with current version, policy, holder and open-proposal counts ([spec](interface-api.md#agent-role-endpoints))
- `POST /admin/roles` — admin session, `content.manage`: create `{slug, display_name, summary, policy?}` ([spec](interface-api.md#agent-role-endpoints))
- `GET /admin/roles/{slug}` — admin session, `content.read`: role, published versions, draft and active holders ([spec](interface-api.md#agent-role-endpoints))
- `PATCH /admin/roles/{slug}` — admin session, `content.manage`: edit a role (compare-and-swap on `expected_version`) ([spec](interface-api.md#agent-role-endpoints))
- `GET /admin/roles/{slug}/timeline` — admin session, `content.read`: versions and proposals with gates, judge and reviews ([spec](interface-api.md#agent-role-endpoints))
- `GET /admin/roles/{slug}/versions/{version}` — admin session, `content.read`: one version's manifest and text files ([spec](interface-api.md#agent-role-endpoints))
- `PUT /admin/roles/{slug}/draft` — admin session, `content.manage`: save the operator draft `{manifest, files, changelog?}` ([spec](interface-api.md#agent-role-endpoints))
- `DELETE /admin/roles/{slug}/draft` — admin session, `content.manage`: discard the draft ([spec](interface-api.md#agent-role-endpoints))
- `POST /admin/roles/{slug}/publish` — admin session, `content.manage`: publish the draft as the next immutable version ([spec](interface-api.md#agent-role-endpoints))
- `POST /admin/roles/{slug}/revert` — admin session, `content.manage`: publish a new version carrying an earlier one ([spec](interface-api.md#agent-role-endpoints))
- `POST /admin/roles/{slug}/versions/{version}/withdraw` — admin session, `content.manage`: withdraw a faulty version from new activations ([spec](interface-api.md#agent-role-endpoints))
- `GET /admin/roles/proposals/{id}` — admin session, `content.read`: proposal with current and proposed bodies and its event trail ([spec](interface-api.md#agent-role-endpoints))
- `POST /admin/roles/proposals/{id}/decide` — admin session, `content.manage`: accept or reject a role proposal ([spec](interface-api.md#agent-role-endpoints))
- `GET /admin/agent-messaging/scopes/state` — admin session, `agent_messaging.read`: read the scope-coordination switch ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /admin/agent-messaging/scopes/state` — admin session, `agent_messaging.manage`: set the scope-coordination switch ([spec](interface-api.md#scope-coordination-endpoints))
- `GET /admin/agent-messaging/scopes` — admin session, `agent_messaging.read`: list coordination scopes ([spec](interface-api.md#scope-coordination-endpoints))
- `GET /admin/agent-messaging/scopes/{scopeId}/members` — admin session, `agent_messaging.read`: list members of a scope ([spec](interface-api.md#scope-coordination-endpoints))
- `POST /admin/agent-messaging/scopes/resolve` — admin session, `agent_messaging.manage`: resolve a scope from host and directory facts ([spec](interface-api.md#scope-coordination-endpoints))
- `GET /admin/agent-messaging/chats` — admin session, `agent_messaging.read`: list shared chat rooms ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/read` — admin session, `agent_messaging.reveal_content`: read a chat room ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/seen` — admin session, `agent_messaging.reveal_content`: mark a chat room as seen ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/send` — admin session, `agent_messaging.manage`: post to a chat room ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/create` — admin session, `agent_messaging.manage`: create a chat room ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/manage` — admin session, `agent_messaging.manage`: manage chat-room members and settings ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/{roomId}/events/{eventId}/reactions` — admin session, `agent_messaging.manage`: react to a chat event (also needs `agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/{roomId}/events/{eventId}/pin` — admin session, `agent_messaging.manage`: pin or unpin a chat event (also needs `agent_messaging.reveal_content`) ([spec](interface-api.md#shared-conversations))
- `GET /admin/agent-messaging/chats/{roomId}/pins` — admin session, `agent_messaging.reveal_content`: pinned events of a chat room ([spec](interface-api.md#shared-conversations))
- `GET /admin/agent-messaging/search` — admin session, `agent_messaging.reveal_content`: search chat content ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/{roomId}/attachments` — admin session, `agent_messaging.manage`: start an attachment upload ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/{roomId}/attachments/{attachmentId}/chunks` — admin session, `agent_messaging.manage`: upload an attachment chunk ([spec](interface-api.md#shared-conversations))
- `POST /admin/agent-messaging/chats/{roomId}/attachments/{attachmentId}/seal` — admin session, `agent_messaging.manage`: seal an uploaded attachment ([spec](interface-api.md#shared-conversations))
- `GET /admin/agent-messaging/chats/{roomId}/attachments/{attachmentId}` — admin session, `agent_messaging.reveal_content`: attachment metadata ([spec](interface-api.md#shared-conversations))
- `GET /admin/agent-messaging/chats/{roomId}/attachments/{attachmentId}/content` — admin session, `agent_messaging.reveal_content`: download attachment content ([spec](interface-api.md#shared-conversations))
- `DELETE /admin/agent-messaging/chats/{roomId}/attachments/{attachmentId}` — admin session, `agent_messaging.manage`: delete an attachment ([spec](interface-api.md#shared-conversations))
- `GET /admin/agent-supervisor` — admin session, `agent_messaging.read`: read configured/effective state, work states, outstanding dependencies and incident budgets ([spec](interface-api.md#fleet-task-supervisor))
- `POST /admin/agent-supervisor/state` — admin session, `agent_messaging.manage`: flip the task-supervisor switch ([spec](interface-api.md#fleet-task-supervisor))
- `POST /admin/agent-supervisor/pause` — admin session, `agent_messaging.manage`: pause a work state (optimistic `version`) ([spec](interface-api.md#fleet-task-supervisor))
- `POST /admin/agent-messaging/messages/{id}/quota-retry` — admin session, `agent_messaging.manage`: retry work held by an emulated quota, keeping its account and native identity ([spec](interface-api.md#emulated-short-quotas-cxx-09150))

## Admin: workflows, schedules and watchdogs

Default spec section: [Workflows and shared runs](interface-api.md#workflows-and-shared-runs); lines with another section link it.

- `GET /admin/schedules` — admin session, `agent_messaging.read`: list schedule definitions (paginated) ([spec](interface-api.md#agent-wake--cron-schedules))
- `GET /admin/schedules/{id}` — admin session, `agent_messaging.read`: read a schedule with its prompt and latest 100 executions ([spec](interface-api.md#agent-wake--cron-schedules))
- `POST /admin/schedules` — admin session, `agent_messaging.manage`: create a schedule ([spec](interface-api.md#agent-wake--cron-schedules))
- `PATCH /admin/schedules/{id}` — admin session, `agent_messaging.manage`: update a schedule (needs the current `version`) ([spec](interface-api.md#agent-wake--cron-schedules))
- `DELETE /admin/schedules/{id}` — admin session, `agent_messaging.manage`: soft-delete a schedule (needs `version`) ([spec](interface-api.md#agent-wake--cron-schedules))
- `GET /admin/watchdogs` — admin session, `agent_messaging.read`: list watchdogs ([spec](interface-api.md#watchdog-wrapper-0936))
- `GET /admin/watchdogs/{id}` — admin session, `agent_messaging.read`: read one watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /admin/watchdogs` — admin session, `agent_messaging.manage`: create a watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `POST /admin/watchdogs/{id}/disable` — admin session, `agent_messaging.manage`: disable a watchdog ([spec](interface-api.md#watchdog-wrapper-0936))
- `GET /admin/workflow-definitions/state` — admin session, `workflows.read`: read module availability
- `POST /admin/workflow-definitions/state` — admin session, `workflows.manage`: set enabled with a stable client_request_id
- `GET /admin/workflow-definitions` — admin session, `workflows.read`: list definitions with bounded pagination
- `POST /admin/workflow-definitions` — admin session, `workflows.manage`: create a validated document and initial immutable version
- `GET /admin/workflow-definitions/{id}` — admin session, `workflows.read`: read current definition
- `GET /admin/workflow-definitions/{id}/versions` — admin session, `workflows.read`: list immutable versions
- `GET /admin/workflow-definitions/{id}/versions/{version}` — admin session, `workflows.read`: read one pinned document and diff
- `POST /admin/workflow-definitions/{id}/revise` — admin session, `workflows.manage`: publish document using expected_workflow_version
- `POST /admin/workflow-definitions/{id}/archive` — admin session, `workflows.manage`: archive using expected_workflow_version and expected_control_version
- `POST /admin/workflow-definitions/{id}/restore` — admin session, `workflows.manage`: restore archived definition with both expected revisions
- `POST /admin/workflow-definitions/{id}/revert` — admin session, `workflows.manage`: publish the selected version as a new version
- `GET /admin/workflow-runs` — admin session, `workflows.read`: list runs by workflow/status with bounded pagination
- `POST /admin/workflow-runs` — admin session, `workflows.run`: prepare a pending run with workflow_id, version (latest or number), title and inputs
- `GET /admin/workflow-runs/{id}` — admin session, `workflows.read`: read durable state, membership and task summaries
- `GET /admin/workflow-runs/{id}/events` — admin session, `workflows.read`: read ordered events using the sequence cursor and limit
- `GET /admin/workflow-runs/{id}/report` — admin session, `workflows.read`: read the live or frozen final report
- `GET /admin/workflow-runs/{id}/tasks/{taskId}` — admin session, `workflows.read`: read task attempts and evidence
- `POST /admin/workflow-runs/{id}/control` — admin session, `workflows.run`: configure a pending run, pause/resume/block, request cancellation or recover coordinator according
- `POST /admin/workflow-runs/{id}/prepare-cancel` — admin session, `workflows.run`: cancel an untouched preparation

## Admin: coordination services

Default spec section: [Feedback admin endpoints](interface-api.md#feedback-admin-endpoints); lines with another section link it.

- `GET /admin/git-director/state` — admin session, `git_director.read`: module switch, the model used for contended verdicts, and live clone/worktree counts ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/git-director/commit-settings` — admin session, `git_director.read`: read the fleet-wide commit-message style ([spec](interface-api.md#fleet-commit-preferences))
- `POST /admin/git-director/commit-settings` — admin session, `git_director.manage`: set the fleet-wide commit-message style ([spec](interface-api.md#fleet-commit-preferences))
- `POST /admin/git-director/state` — admin session, `git_director.manage`: flip the Git Director switch ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/git-director` — admin session, `git_director.read`: every live clone with its worktrees, the current lease and queue per branch ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/git-director/requests/{id}/decide` — admin session, `git_director.manage`: force allow or deny on one merge request ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/git-director/worktrees/{id}/release` — admin session, `git_director.manage`: evict a forgotten registration and withdraw everything it was holding ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/transfers/state` — admin session, `transfers.read`: module switch, the TTL band, the per-file and fleet-wide byte caps ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/transfers/state` — admin session, `transfers.manage`: flip the file-transfer module switch ([spec](interface-api.md#admin-admin-session-cookie))
- `POST /admin/transfers/limits` — admin session, `transfers.manage`: set transfer TTL, file-size and quota limits ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/transfers` — admin session, `transfers.read`: every held file with its size, type, uploader, fetch count and deadline ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/transfers/{id}/events` — admin session, `transfers.read`: the audit trail for one file: every upload, chunk, fetch and deletion, with who did it ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/transfers/{id}/content` — admin session, `transfers.download`: the bytes, streamed, with `Content-Disposition` carrying the uploader's name ([spec](interface-api.md#admin-admin-session-cookie))
- `DELETE /admin/transfers/{id}` — admin session, `transfers.manage`: retire a file now instead of at its deadline ([spec](interface-api.md#admin-admin-session-cookie))
- `GET /admin/companion/devices` — admin session, `account.self_manage`: list own paired devices and push readiness ([spec](interface-api.md#android-companion))
- `POST /admin/companion/pairings` — admin session, `account.self_manage`: create a single-use five-minute pairing QR ([spec](interface-api.md#android-companion))
- `DELETE /admin/companion/devices/{id}` — admin session, `account.self_manage`: revoke an owned device and clear its FCM token ([spec](interface-api.md#android-companion))
- `GET /admin/feedback/configuration` — admin session, `feedback.read`: feedback mode, explicit runner engine/model, automatic-publication opt-in
- `POST /admin/feedback/configuration` — admin session, `feedback.manage`: save feedback mode, runner and token settings (compare-and-swap on `expected_revision`)
- `POST /admin/feedback/preflight` — admin session, `feedback.manage`: check a feedback title/component for duplicates
- `POST /admin/feedback/{id}/recheck` — admin session, `feedback.manage`: queue a User-mode review or reconcile an uncertain publication
- `GET /admin/feedback/state` — admin session, `feedback.read`: activation state (default off)
- `GET /admin/feedback/summary` — admin session, `feedback.read`: open, in-progress and blocked counts for the top-bar indicator
- `POST /admin/feedback/state` — admin session, `feedback.manage`: flip the feedback module switch
- `GET /admin/feedback` — admin session, `feedback.read`: filtered, paginated inbox
- `POST /admin/feedback` — admin session, `feedback.manage`: idempotent report submission
- `GET /admin/feedback/{id}` — admin session, `feedback.read`: original report, current claim/outcome and history
- `POST /admin/feedback/{id}` — admin session, `feedback.manage`: version-checked triage/comment/outcome update
- `POST /admin/feedback/{id}/claim` — admin session, `feedback.manage`: acquire, renew or release a feedback claim
- `DELETE /admin/feedback/{id}` — admin session, `feedback.manage`: permanently delete one closed report with its history and duplicates
- `POST /admin/feedback/purge` — admin session, `feedback.manage`: bulk-delete closed reports `{statuses, older_than?}` in one transaction
- `GET /admin/external-clients` — admin session, `external_clients.read`: list clients: name, description, trust, enabled, key prefix, address, last poll ([spec](interface-api.md#external-clients))
- `POST /admin/external-clients` — admin session, `external_clients.manage`: create an external client ([spec](interface-api.md#external-clients))
- `PATCH /admin/external-clients/{id}` — admin session, `external_clients.manage`: change name, description, trust or `enabled` ([spec](interface-api.md#external-clients))
- `POST /admin/external-clients/{id}/rotate-key` — admin session, `external_clients.manage`: rotate the client key ([spec](interface-api.md#external-clients))
- `DELETE /admin/external-clients/{id}` — admin session, `external_clients.manage`: delete the client ([spec](interface-api.md#external-clients))
- `GET /admin/connectors/config` — admin session, `account.self_manage`: read connector configuration ([spec](interface-api.md#oauth-chat-connectors))
- `PUT /admin/connectors/config` — admin session, `security.manage_authorization`: set connector configuration ([spec](interface-api.md#oauth-chat-connectors))
- `POST /admin/connectors/preview` — admin session, `account.self_manage`: preview a connector configuration ([spec](interface-api.md#oauth-chat-connectors))
- `POST /admin/connectors/clients` — admin session, `account.self_manage`: create connector clients ([spec](interface-api.md#oauth-chat-connectors))
- `GET /admin/connectors/connections` — admin session, `account.self_manage`: list connector connections ([spec](interface-api.md#oauth-chat-connectors))
- `DELETE /admin/connectors/connections/{id}` — admin session, `account.self_manage`: revoke a connector connection ([spec](interface-api.md#oauth-chat-connectors))
- `GET /admin/connectors/consent/{id}` — admin session, `account.self_manage`: show a pending OAuth consent ([spec](interface-api.md#oauth-chat-connectors))
- `POST /admin/connectors/consent/{id}` — admin session, `account.self_manage`: decide a pending OAuth consent ([spec](interface-api.md#oauth-chat-connectors))
