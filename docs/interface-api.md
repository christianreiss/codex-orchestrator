# API Interface (Source of Truth)

## Host-facing

- Base URL for baked wrappers/installers honors `PUBLIC_BASE_URL` when set; otherwise it is derived from trusted `X-Forwarded-Host`/`Host` + trusted `X-Forwarded-Proto` (`TRUST_X_FORWARDED=1` and the socket peer address in `TRUSTED_PROXY_CIDRS`, validated against `https?://`). If no valid base can be resolved, installer creation fails and host `/auth` responses omit per-host wrapper baking metadata.
- Base URL policy guard: when `PUBLIC_BASE_URL_REQUIRED=1` (default in production), requests fail fast if `PUBLIC_BASE_URL` is missing/invalid. Optional host validation (`STRICT_HOST_VALIDATION=1`) rejects requests whose effective host/port do not match `PUBLIC_BASE_URL`.
- MCP origin policy: `/mcp` has no origin allowlist — while `MCP_ALLOW_REQUEST_HOST_ORIGIN` is off (the default) any request that sends an `Origin` header is rejected with 403, and enabling it accepts every origin.
- Contract schemas for critical host responses live under `docs/contracts/` and are CI-gated: `auth-retrieve.schema.json`, `auth-store.schema.json`, `versions.schema.json`, `sync-status.schema.json`, and `sync-bootstrap.schema.json`.
- Pruning: hosts inactive for `inactivity_window_days` (default 30; set to `0` to disable; configurable in `/admin/policies`) are deleted during host auth/register/admin host listings. Never-provisioned hosts older than 30 minutes are also pruned. Hosts with `expires_at` in the past are pruned as well (temporary/rescue hosts; expiry is refreshed on successful host contact).
- `POST /auth` — retrieve/store canonical `auth.json` for the calling host. Requires API key (`X-API-Key` or `Authorization: Bearer`). Engine resolution is multi-source: request body `engine`, query `?engine=...`, `X-Engine`, then wrapper user-agent fallback (`clx` => `claude`), defaulting to `codex`; if that engine is not enabled in the host's `engines` set the server returns `403 engine_disabled`. `command` defaults to `retrieve`; `last_refresh` and `digest` are optional on `retrieve` (fresh-install/missing probes omit them), and when supplied they must be RFC3339 within the accepted bounds (≥ 2000-01-01, ≤ now+300s) and 64-hex respectively. `store` needs an `auth` payload with RFC3339 `last_refresh` plus `auths`; when `auths` is missing, Codex synthesizes it from `tokens.access_token` / `OPENAI_API_KEY`, while Claude synthesizes `auths["api.anthropic.com"]` from `api_key`, `anthropic_api_key`, `ANTHROPIC_API_KEY`, or `claudeAiOauth.accessToken`. The payload may include `session_started_at` (RFC3339) for compatibility with long-running clients. Tokens are canonicalized and quality-checked (no whitespace, min length `TOKEN_MIN_LENGTH` default 24 with an 8-char floor, rejects placeholders/low-entropy). Store requests are serialized per engine, runner-validated, and compare-and-swapped against canonical again before persistence; only recognized provider authentication rejection is definitive, while runner/provider/CLI infrastructure failures reject the upload without poisoning canonical auth. Retrieve/startup responses do not run live runner probes; they report the latest stored verification verdict maintained by the background auth-verification worker. Claude runner validation uses native Claude CLI validation for `claudeAiOauth` / `sk-ant-oat...` account-login payloads, and uses the direct Anthropic messages API only for genuine API-key credentials; Anthropic `rate_limit_error` probes count as valid credentials with temporary quota pressure. The same runner-validation/update path also applies to admin `/admin/auth/upload` and `/seed/auth/{uuid}` uploads, so runner `updated_auth` can become canonical from any upload path. Canonical payloads may be system-owned (`source_host_id = null`) and still count as valid canonical auth. Canonical auth, recent digests, and last-served host state are all engine-scoped; Codex and Claude do not share one canonical payload pointer. When the client digest differs but `last_refresh` matches canonical, `retrieve` returns `upload_required` and a runner‑validated `store` may update canonical. Optional `installation_id` must match the server’s `INSTALLATION_ID` when provided; mismatches return `403 installation_mismatch` while omitted values are treated as legacy clients. Responses include status (`valid`/`upload_required`/`outdated`/`missing` for `retrieve`; `updated`/`valid`/`outdated` for `store`), optional `action:"store"` on retrieve when an upload is required, `versions` (client/wrapper plus `client_version_source`, `client_version_checked_at`, `client_version_enforce_exact`, `wrapper_sha256`, `wrapper_url`, `reported_client_version`, `auto_update_enabled`, runner telemetry, `installation_id`, and `admin_theme`), `api_calls`, `quota_hard_fail`, `quota_limit_percent`, `quota_week_partition` (0/off, 5, or 7), `cdx_silent`, and optional `host` metadata (fqdn/status/last_refresh/claude_last_refresh/updated_at/expires_at, client_version/client_version_override/claude_client_version/claude_client_version_override/agents_document_id_override/wrapper_version/claude_wrapper_version, secure/vip/allow_roaming_ips, `engines` plus parsed `engines_list`, insecure window timestamps + `insecure_window_minutes`, `browseros_mcp_enabled`, optional `lane_preference` (`normal`/`spark`) for wrapper lane steering, optional `model_override` / `reasoning_effort_override` for Codex, and `claude_model_override` / `claude_reasoning_effort_override` for Claude). The Codex fleet target has an internal minimum floor of `0.125.0`; lower fleet pins, lower host overrides, and stale GitHub/cache results are all raised to that floor. Claude CLI targets use `ClaudeVersionPolicy` and support fleet and host pins through the parallel Claude version fields. `client_version_enforce_exact=true` means wrappers must match the target exactly (upgrade or downgrade). `client_version_enforce_exact=false` means the target is floor-only and wrappers only upgrade toward it. `auto_update_enabled=true` tells wrappers the effective fleet/host policy is cron-managed auto-update; normal sync-capable runs reconcile the managed cron entry to match that policy before deciding whether to skip the redundant startup update probe. Distributable canonical auth is returned only when the server copy is older-client-authoritative; a selected `verification_state=failed` lineage is reported as `outdated` without an `auth` blob. Codex responses always include a `chatgpt` object. With a readable snapshot it carries status/plan and provider flags (`rate_allowed`, `rate_limit_reached`, `spark_rate_allowed`, `spark_rate_limit_reached`) and exposes both quota lanes: `normal_window` and optional `spark_window` (each has `primary_window` + `secondary_window` with `used_percent`, `limit_seconds`, and reset timings), plus lane metadata (`spark_limit_name`, `spark_metered_feature`). With no snapshot, or when its read fails, the object is `{status:"unavailable", active_quota_lane:<host-effective lane>}` rather than `null`/omitted. Its `active_quota_lane` is host-effective response state, not account-snapshot state: a host with `lane_preference:"spark"` receives `spark`; every other host receives `normal`. Legacy clients keep working via the compatibility keys `primary_window` and `secondary_window` (mapped to the normal lane). `next_eligible_at` and daily partition metadata remain unchanged; the server refreshes snapshots opportunistically with a 5-minute cooldown. When reverse DNS enforcement is enabled (globally or per-host), `/auth` requests are rejected unless the caller IP appears in the host's A/AAAA records **and** the PTR record resolves back to the host FQDN. Denials expose stable reason details used by wrappers and tooling: `reverse_dns_mismatch`, `insecure_api_disabled`, and `installation_mismatch`. Insecure hosts default to API deny for retrieve-style access: registering an insecure host opens a provisioning window (defaults to 30 minutes, or `duration_minutes` from `/admin/hosts/register` when provided); dashboard "Enable" exposes a log-ish 0–480 minute (0–8 hour) slider (default 10) that opens a sliding `/auth` window, and each non-store `/auth` call extends the window by the configured duration. Submitted `/auth` `store` payloads are always treated as candidates regardless of insecure window/approval state, but still require normal auth/IP/reverse-DNS/installation checks and runner validation before persistence. "Disable" closes the window immediately. When insecure approvals are enabled and an admin websocket client is connected, closed-window `retrieve` requests return HTTP 423 `Insecure host approval pending` and `cdx` polls until approved or denied; pending approval requests auto-deny after five minutes and then return `403 insecure_denied` to the polling host. Active insecure-domain allows auto-open windows for matching subdomains during their allowed window, and those domain allow entries auto-revoke once the window expires. When `host.secure` is `false`, the last exiting auth-aware cdx/clx process purges native credentials while preserving explicit logout intent.
- `/auth` native credential normalization: Codex selection matches native
  `AuthDotJson`: explicit `auth_mode` wins; otherwise a present top-level
  `OPENAI_API_KEY` wins over `tokens.access_token`. Accepted input is persisted
  as one native `chatgpt` or `apikey` shape with the shadow credential removed;
  unsupported modes fail closed, while legacy nested/auths keys are normalized
  before live verification. Claude selects native `claudeAiOauth` before API-key
  aliases and rejects `sk-ant-oat...` outside a non-empty native OAuth object.
  Both engines strip the unselected native shadow and every non-native `auths`
  target before live verification and persistence. Pending, failed,
  non-canonical legacy, partial/stale-fingerprint, and fingerprint-mismatched
  rows never include auth bytes in retrieve/bootstrap. The worker immediately
  probes and reissues a nominally verified unsafe row, even when only its
  fingerprint metadata—not its canonical body—needs replacement. When a store
  probe changes the native credential before returning non-OK, persistence
  quarantines that replacement and atomically marks the same-lineage head
  failed only if that exact row is still selected. Unrelated credentials and a
  different concurrent compare-and-swap winner remain distributable.
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
- `DELETE /auth` — uninstall auth registration. `?engine=codex|claude` removes
  only that engine, its host digest/state, and engine-specific version metadata
  when another engine remains and returns `{deleted_engine,remaining_engines}`;
  uninstalling the last engine removes the host. Wrappers delete shared
  `cxx`/aliases/cron only from an authoritative last-engine response; partial
  responses retain the remaining alias and shared artifacts, while offline,
  non-2xx, or malformed responses preserve all shared artifacts.
  Legacy requests without `engine` retain whole-host deregistration. IP binding
  is enforced unless `?force=1`; both paths are transactional and audit logged.
- `POST /sync/status` — batched startup diff probe for AGENTS.md and baked `config.toml`. Requires host API key + IP binding. Body accepts local digests (`agents.sha256`, `config.sha256`) plus optional host-user context. The `agents` block includes canonical `base_sha256`, combined `managed_sha256`, separate policy/features digests, and stable `sections` diagnostics for the mandatory fleet/safety/hard-stop prefix plus `skills`, `memories`/`memory_routing`, `projects`, `browseros`, `secrets`, and `api_keys_in_chat`. Metadata describes guidance, never inventories. Optional `include_auth` retains the existing auth semantics. Contract: `docs/contracts/sync-status.schema.json`.
- `POST /sync/bootstrap` — batched startup payload endpoint. Uses the same input shape as `/sync/status`; when updates exist it returns changed payloads in one response (`agents.content`, `config.content`) plus `host_users`. Every successful response also includes the historical compatibility key `sessions:{now,today,month}` for the shared cdx/clx `ACTIVITY` section; older servers may omit it. These values are sync activity, not sessions or launches: `now` is distinct hosts with an `agents.retrieve` log in the prior 30 minutes, while `today` and `month` are total `agents.retrieve` attempts since the UTC day/month boundaries. Wrappers pair them with their local same-UID wrapper process count and label the rows `local procs`, `hosts 30m`, `syncs UTC day`, and `syncs UTC month`. The `agents` block carries the same `base_sha256` / `managed_sha256` / `sections` metadata as `/sync/status`, so hosts and operators can inspect which feature hints affect the served engine/host document before or after a content fetch. Codex Skills are not bundled as local files; cdx reads manifests/support files through MCP `resource_read` at `skill://{slug}` / `skill://{slug}/{path}`. Claude hosts instead receive `claude_skills`, the complete live set of native Skill directory bundles; each changed source-owned item includes its rendered `SKILL.md` plus every `skill_files` entry, and the bundle digest changes when either the manifest or a support file changes. Optional `include_auth` (default true) adds the same auth block as `/sync/status`; optional `auth_candidate` lets the endpoint auto-run the runner-validated `/auth` store path before returning canonical auth. Native Claude candidates without `last_refresh` are canonicalized for comparison first: if they match canonical they return `valid`; if they differ and are usable they are stored with a server timestamp instead of being overwritten by canonical auth. Successful inline stores add the `auth_stored` reason. When `include_auth=false`, no `/auth` retrieve/store path runs. Contract: `docs/contracts/sync-bootstrap.schema.json`.
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
  runner state, API and auto-update flags, `cdx_silent`/`clx_silent`,
  installation ID, and engine. Quota controls and ChatGPT telemetry are sibling
  auth fields, not nested version fields.
- `POST /host/users` — record the calling host’s current `username`/`hostname` and return all known users for that host. Requires host API key (`X-API-Key` or `Authorization: Bearer`) and IP binding. Response: `{ users: [{ username, hostname, first_seen, last_seen }, ...] }`. Rows are deleted automatically when the host is removed.
- `GET /host/lane` — returns lane steering metadata for the calling host. Requires host API key + IP binding and applies insecure-window checks. Response includes `lane_preference` (`normal`/`spark`/`null`) and `effective_lane`.
- `POST /host/lane` — set/clear host lane preference with body `{ lane: "normal" | "spark" | null }` (use `null` to clear). Requires host API key + IP binding and applies insecure-window checks. Changes affect wrapper lane steering on the next `cdx` run.
- OpenAI-compatible API:
  - `POST /v1/chat/completions` — OpenAI-compatible chat completions. `messages[].content` may be a plain string or an OpenAI-style content-part array. Text parts plus `image_url` / `input_image` parts are normalized and forwarded to the runner, which materializes image URLs or base64 `data:` URLs into real `codex exec --image` attachments. Non-streaming returns a standard `chat.completion` object. Streaming now emits SDK-compatible `chat.completion.chunk` SSE payloads with `choices[].delta.content` and a final `[DONE]`. `model` must be one of the shared supported Codex models returned by `/v1/models`; when omitted, the API resolves the default from the saved main config model and falls back to `versions.cdx_model`.
  - `POST /v1/responses` — minimal OpenAI-compatible Responses API compatibility adapter for non-streaming clients. Accepts `input` as a string, a bare content-part array, or a message-style array plus optional `instructions`, maps the request onto the backend chat flow, and returns a `response` object with `output[0].content[0].type="output_text"`. Text parts plus `image_url` / `input_image` parts are supported, including base64 `data:` URLs. `stream:true` is currently rejected on this endpoint. `model` uses the same strict allowlist and default-resolution behavior as chat completions.
  - `POST /v1/completions` — legacy text completions endpoint. `model` uses the same strict allowlist and default-resolution behavior as chat completions.
  - `POST /v1/embeddings` — placeholder endpoint; returns `501` / `not_implemented` against the current backend.
  - `GET /v1/models` — lists the supported Codex model ids from the shared config/model allowlist used by the OpenAI-compatible API.
  - `GET /v1/models/{model}` — retrieves a single model object. Legacy aliases resolve to their current id; an empty or unknown id returns `404 model_not_found`.
  - `OPTIONS /v1/*` — CORS preflight for every OpenAI-compatible route; returns 204.
- Anthropic-compatible API (see [Anthropic-compatible API](#anthropic-compatible-api) section below for full details):
  - `POST /anthropic/v1/messages` — Anthropic-compatible Messages API. Accepts `messages` with `role`/`content`, optional `model`, `system` (string or text-block array), `stream`, `max_tokens`, `temperature`, `top_p`, `top_k`. System messages in the `messages` array are extracted and handled separately per Anthropic convention; a top-level `system` block array is flattened into one string. Content can be a string or an array of content blocks (text, image). Non-streaming returns an Anthropic message format response. Streaming returns Server-Sent Events with event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`. Authentication requires a Claude API key via `Authorization: Bearer sk-claude-...` or `x-api-key: sk-claude-...`.
  - `POST /anthropic/v1/messages/count_tokens` — token-count estimate for a prospective request. Takes the same `messages` / `system` / `tools` shape as `/anthropic/v1/messages` but does not require `max_tokens`, and returns `{input_tokens}`. The runner shells out to the `claude` CLI rather than a raw model endpoint, so the count is a character-based estimate and will not match the real API exactly.
  - `POST /anthropic/v1/completions` — Anthropic-compatible text completion endpoint. Accepts `prompt` and optional `model`. Returns completion in Anthropic format.
  - `POST /anthropic/v1/complete` — the upstream spelling of `POST /anthropic/v1/completions`; same handler, same body and response.
  - `GET /anthropic/v1/models` — lists available Claude models (`claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) in the Anthropic Models API shape; Sonnet 5 is the default.
  - `GET /anthropic/v1/models/{model_id}` — retrieves a single model object; unknown ids return `404 not_found_error`.
  - `POST /anthropic/v1/responses` — Minimal Responses API compatibility adapter for non-streaming clients. Accepts `input` (string, content-part array, or message-style array) plus optional `instructions`. Maps the request onto the Claude Messages backend and returns an OpenAI-compatible `response` object. `stream: true` is rejected.
  - `POST /anthropic/v1/embeddings` — Placeholder endpoint; returns `501` / `not_implemented` as Anthropic does not support embeddings.
  - `OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions`, `OPTIONS /anthropic/v1/responses`, `OPTIONS /anthropic/v1/embeddings` — CORS preflight for Anthropic routes.
- `GET /wrapper` — wrapper bakery v2 manifest. Aliased to `GET /wrapper/v2/meta`. Returns `{engine, binaries: { "<os>-<arch>": {version, sha256, size_bytes, url_path} }, schema_version}` for the calling host's engine. Auth required.
- `GET /wrapper/download` — host-targeted legacy transition launcher (POSIX `sh`). Auth required; the transition launcher fetches the signed per-host v2 config, installs `cxx` plus the enabled relative alias under the user's data dir, and explicitly execs `cxx <engine>` with the original arguments. Date-versioned shell wrappers receive this URL with no static checksum in `/auth` and `/cron/check` so they do not overwrite themselves with a raw Go binary before config exists.
- `GET /wrapper/v2/download` — raw common `cxx` binary for the calling host's detected platform. Auth required; intended for v2-aware installers/clients that already write the signed config.
- `GET /wrapper/v2/config[?sig=1]` — signed per-host config JSON (or detached signature when `?sig=1`); ETag is the SHA256, `X-Config-Version` is the current `hosts.config_version`. The payload carries the decrypted host API key, never the at-rest SHA-256 lookup digest. Auth required and the requested engine must be enabled for the host.
- `GET /wrapper/v2/manifest/{engine}` — per-platform manifest for `codex` or `claude`; an unknown engine returns `404 unknown_engine`. Auth required.
- `GET /wrapper/v2/bin/{artifact}/{platform}/v:version/{binary}` — versioned binary route; the canonical common shape is `cxx/{platform}/v:version/cxx`. `{platform}` is `os-arch` (for example `linux-amd64`), the version segment is a literal `v` followed by the version, ETag = SHA256, and `Cache-Control: public, max-age=86400, immutable`. Compatible `codex|claude/.../{cdx|clx}` URLs preserve exact historical artifacts and otherwise stream the matching common bytes. Auth required.
- `POST /cron/check` — lightweight cron auto-update probe for the host-wide `cxx-managed` job (alias cron commands forward to the coordinator). Requires host API key but intentionally skips normal host-status/IP/insecure-window gating; updates `last_cron_check` / `updated_at`, records submitted observed `client_version` / `wrapper_version` when present, normalizes labeled client versions such as `codex-cli 0.130.0` before comparing them to fleet targets, and returns top-level client `action` (`disable|no_update|update`) plus target version/tag metadata. Response also carries a nested common `wrapper` block (`action`, `target_version`, host-baked `sha256`, `url`) so cron can self-update `cxx` before attempting engine-client updates; v2 wrappers send `X-Wrapper-Platform: <os>-<arch>` so the response points at the matching platform artifact, legacy date-style shell wrappers get `/wrapper/download?engine=...` plus `sha256:null` for the transition launcher, while v2 wrappers keep the static binary URL/checksum. For backward compatibility the top-level `action` remains client-only, so a wrapper-only update returns `action:"no_update"` with `wrapper.action:"update"`. The first upgraded legacy tick installs the one shared job and removes both `cdx-managed`/`clx-managed` system entries plus lines ending in an exact managed marker from every actual owner discovered in the standard cron spools. Strictly validated spool filenames remain eligible when the static wrapper's Go `os/user` lookup cannot resolve NSS/SSSD accounts; config-owner/sudo/current/root safeguards still require lookup validation. Privileged cleanup snapshots those crontabs and restores them all, while removing the new system entry, if any user or legacy-system cleanup step fails.
- `POST /cron/report` — cron auto-update completion report. Requires the same lightweight cron auth and at least one of `client_version` or `wrapper_version`; updates whichever reported versions are supplied after a successful cron-managed update run. Claude cron reports must include `engine:"claude"` so the parallel Claude version fields are updated.
- `GET /skills` — list registered skills (`slug`, `sha256`, `manifest_sha256`, `display_name`, `description`, `updated_at`, optional `deleted_at`, `managed`, `allow_implicit_invocation`) plus canonical `uri` / `canonical_uri` (`skill://{slug}`) and nullable provenance (`source_type`, `source_repository`, `source_path`, `source_revision`, `source_license`, `bundle_sha256`). For imported skills, `sha256` is the complete bundle digest while `manifest_sha256` remains the raw manifest digest. Auth required. This route remains available for inventory/admin-adjacent clients, but cdx reads Skill content through MCP resources instead of local sync.
- `POST /skills/retrieve` — body: `slug` (required; accepts legacy `filename`) and optional `sha256`. Returns `status` (`missing` | `deleted` | `unchanged` | `updated`), canonical `uri`, digest/provenance/managed/invocation metadata, and `manifest` when the stored content differs. Host runtimes should prefer MCP `skill://{slug}` reads.
- `POST /skills/store` — body: `slug`, `manifest` (required string; canonical Skill `SKILL.md` markdown content), optional `display_name`/`description`, optional `sha256` (validated against `manifest`). Stores/updates canonical skill specs, logs `skill.store`, and returns `status` (`created` | `updated` | `unchanged`) with canonical `sha256`. When `description` is omitted and the manifest is new/changed, the API may ask the runner to generate a short summary and persist it into `skills.description`; runner summary failures do not fail the store request. Code-managed slugs and rows with non-blank `source_type` are read-only here and reject store/delete attempts.
- Claude artifacts (host API key auth; `{kind}` is `subagent`, `command`, or `output-style`, and plural/alias spellings are accepted):
  - `GET /claude/{kind}` — list the served artifacts of that kind: `slug`, `sha256`, `display_name`, `description`, `model`, `updated_at`, `engine`.
  - `POST /claude/{kind}/retrieve` — body: `slug` (accepts legacy `filename`) plus optional `sha256` (64-hex). Returns `status` (`missing` | `deleted` | `unchanged` | `updated`) and the artifact body when updated.
- `POST /agents/retrieve` — pull the served agent document (`AGENTS.md` for Codex, `CLAUDE.md` for Claude). Optional `sha256` supports unchanged responses. Every render replaces a mandatory `cxx:managed-policy` prefix containing Fleet Identity, precedence/safety floor, and Hard Stop Lines, then preserves the canonical base, then replaces the `cxx:managed-features` suffix in fixed Skills, Memory, Projects, BrowserOS, Secrets, API keys in chat order. Response metadata exposes combined `managed_sha256`, separate `policy_sha256` / nullable `features_sha256`, and mandatory section diagnostics alongside the capability sections. Codex Skill guidance makes MCP authoritative without overriding higher-level built-in/system Skill requirements; Memory and Secrets retain their safe read/write contracts. The served digest covers all three layers while `base_sha256` remains the canonical body digest. Missing canonical content preserves an existing local document, and per-host overrides still take precedence.
- `POST /config/retrieve` — pulls the canonical config template and bakes a per-host `config.toml` using the authenticated host context. Optional body fields `username` and `home` allow the server to append a trusted project stanza (`[projects."<home>"] trust_level = "trusted"`) to silence Codex trust warnings for the calling user. Managed MCP entry now uses the native HTTP MCP transport (no npm):
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
  - `GET /projects` — returns `{ projects: [...] }` where each summary includes `slug`, `title`, `name`, `description`, `about`, `latest_seq`, `created_at`, and `updated_at`.
  - `POST /projects` — body: `slug` (required), optional `about` object, optional `roster_markdown` or `agents_markdown`. Returns full project detail payload.
  - `GET /projects/{slug}` — full shared state: `project` (summary/counts/seq), `notes`, `todos`, `files`, `feedback`, `memories`, and `recent_changes`.
  - `GET /projects/{slug}/bootstrap` — compact context payload: `project`, `about`, `roster_markdown`, `latest_seq`, `counts`, `recent_notes`, `recent_todos`, `recent_files`, `recent_memories`, `recent_changes`, managed `skill` metadata (`slug`, canonical `uri`), native `instructions`, native `quickstart`, and `routes`. `recent_memories` is capped at 8 and carries previews only (`preview`, `content_length`, no `content`), unlike `recent_files` which inlines full content. The embedded guidance is project-only for CoCo shared handoffs and points durable shared memory at `project_memory_*`, warning that `memory://...` remains host-scoped.
  - `POST /projects/{slug}/about` — body `{about:{...}}` or a raw object; returns `{ project, about }`.
  - `POST /projects/{slug}/roster` — body `{roster_markdown}` or `{markdown}`; returns `{ project, roster_markdown }`.
  - `GET /projects/{slug}/changes` — optional `since` (query/body, normalized `>=0`); returns `{ project, since, latest_seq, changes[] }`.
  - Notes: `GET /projects/{slug}/notes`, `POST /projects/{slug}/notes`, `POST /projects/{slug}/notes/{id}`, `DELETE /projects/{slug}/notes/{id}`. Create/update require `header` + `body`. Delete returns `{ project, deleted:id }`.
  - Todos: `GET /projects/{slug}/todos`, `POST /projects/{slug}/todos`, `POST /projects/{slug}/todos/{id}`, `POST /projects/{slug}/todos/{id}/done`, `POST /projects/{slug}/todos/{id}/undone`, `DELETE /projects/{slug}/todos/{id}`. Create/update require `title`; todo payloads include boolean `done` and optional `done_at`.
  - Files: `GET /projects/{slug}/files`, `POST /projects/{slug}/files`, `DELETE /projects/{slug}/files/{id}`. Upsert requires `stored_name` (or `name`) plus `content`; optional `description` and `mime_type`. Returned file payloads include `content`, `content_sha256`, `size_bytes`, `created_at`, and `updated_at`.
  - Feedback: `GET /projects/{slug}/feedback`, `POST /projects/{slug}/feedback`. Create requires `type` (`bug|feature|note|issue|test`), `title`, and `body`; new entries start with `status:"open"`.
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
  - `POST /shared-memories/write` — body: `slug` (required, `^[a-z0-9][a-z0-9._:-]*$`, ≤160 chars, lower-cased on write), `content` (required, ≤1048576 chars), optional `title` (≤255, defaults to the slug), `summary` (≤1000), `metadata` (object), `tags` (≤32, ≤64 chars each), `engine` (provenance only), and `expected_sha256`. When `expected_sha256` is supplied and does not match the stored digest the write is rejected with `409 shared_memory_conflict` instead of clobbering a concurrent writer. Status: `created` | `updated` | `unchanged` — an `unchanged` re-store writes nothing and burns no revision.
  - `POST /shared-memories/append` — body: `slug` and `content` (required), optional `heading` (rendered as an `## ` block), `separator` (default `\n\n`), `title`, `summary`, `tags`, `metadata`, `engine`. Creates the document when the slug is absent. This is the multi-writer-safe path: two agents appending concurrently both keep their text, where a read-modify-write pair would silently drop one. Tags are unioned, not replaced. Status: `created` | `appended` | `unchanged`, plus `appended_chars`.
  - `POST /shared-memories/delete` / `DELETE /shared-memories/{slug}` — soft-deletes the document and drops its chunks; the slug stays reserved and a later write revives it. Returns `status` (`deleted` | `missing`).
- `GET /mcp` — transport probe; returns 405 with `Allow: POST`.
- `POST /mcp` — the JSON-RPC 2.0 transport itself (single call or batch). Methods include `initialize`, `tools/list`, `tools/call`, resource operations, and dot aliases. `initialize` returns server-wide instructions requiring clients to inspect deferred catalogs rather than infer tool absence and to probe secrets capability through read-only `secret_list`. Skill reads honor `X-Engine`; host `skill_store`/`skill_delete` mutate only shared manifest-only Skills and reject managed/source-owned rows.
- Streamable HTTP MCP endpoint (`/mcp`, protocol `2025-03-26`) authenticates in `resolveHost()` (`api/src/routes/mcp/index.ts`): the presented credential is first checked as a short-lived MCP session token (`McpSessionService.verify`) and otherwise resolved as a host API key (`app.resolveHostFromKey`), after which non-`active` hosts are rejected. It advertises host-safe `memory_*`, `shared_memory_*`, `skill_list`, `skill_retrieve`, `skill_store`, `skill_delete`, `resource_*`, `project_*`, and `secret_*` tools. Coordinator filesystem helpers (`fs_*`) remain operator-only and are neither exposed nor dispatchable to host callers. Tool names use underscores to satisfy `^[a-zA-Z0-9_-]+$`; `tools/call` still accepts dot aliases for backward compatibility.
  - MCP resources: `resources/templates/list` returns templates `memory_by_id` (`uriTemplate: memory://{id}`), `memory_store` (`uriTemplate: memory://{scope}:{name}`), `skill_manifest` (`uriTemplate: skill://{slug}`), `skill_file` (`uriTemplate: skill://{slug}/{path}`), and `shared_memory` (`uriTemplate: shared://{slug}`); when the Projects module is enabled it also returns `project_bootstrap` (`uriTemplate: project://{slug}`). `resources/list` enumerates recent memories for the calling host (up to 20), the 50 most recently updated shared memories as `shared://{slug}` markdown resources, canonical Skills as `skill://{slug}` markdown resources, up to 128 support files per source-owned skill as `skill://{slug}/{path}`, and, when enabled, active shared projects as `project://{slug}` resources. A manifest with `disable-model-invocation: true` is described as `[Explicit user invocation only]`; this policy is not silently widened by import. `resources/read` fetches a single memory as `text/plain` when given `uri=memory://{id}`, a shared memory body as `text/markdown` when given `uri=shared://{slug}`, a Skill manifest as `text/markdown` when given `uri=skill://{slug}`, an exact support file when given `uri=skill://{slug}/{path}`, or a project bootstrap JSON document when given `uri=project://{slug}`. Bundled manifests receive a read-time note pointing relative references at the MCP file URI and warning that bundled scripts are reference text, not execution authority. `resources/create`/`update`/`delete` accept `shared://{slug}` as well, though that path carries only text. Existing shared documents require a complete offset-zero read with one stable digest and `expected_sha256` before either whole-body resource replacement, while delete is reserved for a wholly invalid or superseded record. `shared_memory_write` remains the full-fidelity surface and the only one that records an engine. CoCo coordination state still lives only in project resources.
- `GET /versions` — version snapshot (no auth; `503 api_disabled` while the `api_disabled` flag is set). The envelope `data` is the `codex`-engine `VersionSnapshot` of `api/src/services/version-snapshot.ts`, as codified in `versions.schema.json`. Keys: `client_version`, `client_version_override`, `client_version_enforce_exact`, `wrapper_version`, `wrapper_sha256`, `wrapper_url`, `runner_state`, `api_disabled`, `auto_update_enabled`, `cdx_silent`, `clx_silent`, `agent_messaging_enabled`, `installation_id`, `engine`. Wrapper metadata comes from the v2 `BinaryRegistry` (canonical platform `linux-amd64` under `storage/wrapper/v2/bin/cxx/linux-amd64/v<version>/cxx`); clients cannot publish. The fleet target has an internal minimum floor of `0.125.0`; `client_version_enforce_exact=true` means an admin pinned an above-floor version that wrappers should match exactly, while `false` means the target is floor-only and wrappers must not downgrade to meet it. `auto_update_enabled=true` tells wrappers that cron-managed auto-update is the intended update path.
- `GET /healthz` — unauthenticated liveness probe: `{ok:true, ts}`.
- `GET /readyz` — unauthenticated derived readiness probe; returns 503 until migrations, runner, encrypted signer, complete four-platform wrapper matrix, and Public Base URL checks pass. `/healthz` remains liveness-only.
- `GET /admin/setup/status` — public only before the first admin exists, then session-gated; returns secret-free readiness, configured engines, verified canonical-auth presence, host/sync counts, warnings, and next actions.
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

Auth verification worker: when `AUTH_RUNNER_URL` is configured, the API starts a background verifier on boot and repeats it every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300). It refreshes the latest Codex and Claude canonical payloads when their stored verification age exceeds `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900), persists runner-refreshed auth, records `verification_state`, and updates per-engine runner telemetry after each stale live probe without making wrapper startup wait on the runner. Runner failures are logged/surfaced and do not block `/auth` retrieve, but every canonical-auth-changing upload, including admin and seed uploads, requires a configured, reachable runner and a positive live verdict.

## Installer

- `GET /install/{token}` — single-use installer script for a pre-registered host. Tokens minted via `/admin/hosts/register` or `/admin/hosts/{id}/installer` (one pending token per host; issuing a new one deletes prior pending tokens), expire after a TTL fixed at 1800s in the API (no env knob), and embed the resolved public base URL (from token metadata, `PUBLIC_BASE_URL`, or trusted forwarded Host/proto) plus the API key/FQDN into the selected installer mode. Registering an existing FQDN rotates the API key; the host-detail mint endpoint reuses the current encrypted key. The installer fetches all enabled configs first and requires identical common version/SHA metadata, installs one `cxx`, and atomically replaces legacy regular wrappers with relative `cdx`/`clx` aliases for enabled engines. Claude-capable modes preflight Node.js/npm: supported package managers provide Node, a pinned Corepack npm 10.9.2 shim is preferred when npm is absent, and the OS npm package is the fallback. It invokes the host-wide `cxx cron install` and `cxx cron run --minimal` paths exactly once each. It prints `READY` only after `cxx`, every requested CLI, and cron setup verify; otherwise it prints `INCOMPLETE`, names direct retry commands, and exits non-zero. It never auto-launches an interactive engine. For hosts with `curl_insecure=true`, internal downloads default to `curl -k`; the copied command also includes `curl -k` plus `CODEX_INSTALL_CURL_INSECURE=1`. Used/expired/missing tokens return shell-script errors.
- `GET /install/v2/{token}` — alias of `GET /install/{token}`; wrappers minted against the v2 URL keep working unchanged.

## Admin (admin session cookie)

- Admin URLs that are both Svelte routes and JSON endpoints return the SPA shell when a browser navigation sends `Accept: text/html`; API clients must continue to send `Accept: application/json` to receive JSON from colliding paths such as `/admin/hosts`, `/admin/projects`, project detail slugs and their `notes` / `todos` / `files` / `feedback` tabs, and `/admin/users`.
- `GET /admin/overview` — hosts count, avg refresh age, latest log timestamp, versions (runner/quota flags included), ChatGPT usage snapshot (cached ≤5m) plus `chatgpt_usage_summary` (lane-oriented normal/spark windows), `chatgpt_cached`/`chatgpt_next_eligible_at`, quota controls (`quota_limit_percent`, `quota_week_partition`), `cdx_silent`, `admin_theme`, `reverse_dns_enabled`, `insecure_approval_enabled`, `inactivity_window_days`, log-retention controls (`log_retention_enabled`, `log_retention_days_logs`, `log_retention_days_mcp`, `log_retention_days_events`, `log_retention_days_graph_stats`), and optional Codex version pin metadata (`client_version_lock`, `client_version_lock_updated_at`).
- `GET /admin/ws/info` — websocket bootstrap for admin live updates. Returns `enabled`, `url`, `last_event_id`, `heartbeat_seconds`, and `backlog_limit`. When enabled, clients connect to the provided `ws/wss` URL and receive event messages of the form `{ kind: "event", event: { id, type, host_id, payload, created_at } }` (currently `type=log.created` and `type=toast`).
  - The same socket also accepts targeted request/response envelopes for late hydration without a page reload. Current supported request: `{ kind: "request", request_id, type: "host-detail-support", payload: { host_id } }`, which replies with `{ kind: "response", request_id, type: "host-detail-support", data: { host_id, runner, agents } }`.
  - Admin clients route published event types into targeted query domains
    (logs, hosts, projects, knowledge, access, fleet settings, messaging, and
    portal state) instead of full-page reloads. Unknown event types do not
    trigger a speculative refresh.
- Settings mutations now emit explicit log actions for push fanout: `admin.api.state`, `admin.cdx_silent`, `admin.theme`, `admin.reverse_dns`, `admin.insecure_approval`, `admin.codex_version`, `admin.quota_mode`, and `admin.prune_policy`.
- `GET /admin/auth/status` — admin auth status (`has_users`, `admin_count`, `enforced`, `authenticated`, `user`, role labels, `passkeys_registered`, and `passkey_login_available`).
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
- `POST /admin/users` — create user `{name, username, email, access_level, password, active?}`. First user must be `admin`.
- `POST /admin/users/{id}` — update user fields (name/username/email/access_level/active/password).
- `DELETE /admin/users/{id}` — delete user (blocked if it would remove the last active admin).
- `POST /admin/users/wipe` — delete all users (confirmation required; returns to userless mode).
- `POST /admin/toasts` — emit an admin toast via websockets. Body: `{ message: string, title?: string, level?: "info"|"success"|"warn"|"error", timeout_ms?: number }` (aliases `body`/`text`, `tone`). Returns the created admin event.
- `GET /admin/hosts` — list hosts with canonical digest, digests history, versions, API calls, IPs (`ip4` and `ip6` when a dual-stack host binds both families), roaming flag, security flag (`secure`), VIP flag (`vip`), configured `engines` plus the parsed `engines_list`, insecure window fields (`insecure_enabled_until`, `insecure_grace_until`, `insecure_window_minutes`), `curl_insecure` (true = bake wrapper with TLS verification bypass for host sync), `browseros_mcp_enabled` (true = bake BrowserOS MCP for this Codex host), per-host overrides (`client_version_override`, `claude_client_version_override`, `agents_document_id_override`, `lane_preference`, `model_override`, `reasoning_effort_override`, `claude_model_override`, `reverse_dns_mode`, `auto_update_override`), `auth_outdated` (true when host digest differs from the current canonical auth), `auth_source` (true when the host last submitted the current canonical auth.json), recorded users (username/hostname/first/last seen), and derived auto-update telemetry: `effective_auto_update_enabled`, `auto_update_state`, `auto_update_label`, `auto_update_emoji`, `auto_update_rank`, `auto_update_last_event_at`, and `auto_update_target_version`.
- `GET /admin/hosts/insecure` — list insecure hosts only (no secure hosts). Returns `count`, `active` (how many have `insecure_enabled_until` in the future), `hosts` with `id`, `fqdn`, `active`, `secure`, and `insecure_enabled_until` (RFC3339, timezone-aware), plus `domains` (`id`, `domain`, `active`, `enabled_until`, `window_minutes`) and `domains_active` for domain auto-allow rules. Intended for quick UI actions (e.g. enable/disable buttons).
- `POST /admin/hosts/insecure/extend` — bulk-extend all currently active insecure windows by each host’s configured duration.
- `POST /admin/hosts/insecure/disable-all` — bulk-close all active insecure windows.
- `POST /admin/hosts/register` — owner/admin role required. Mint a host + single-use installer token for a given FQDN; calling it again for the same FQDN rotates that host’s API key, deletes prior pending installers, generation-fences any Agent Messaging runtime for the former credential, and issues a fresh one. Optional body `secure` (default `true`) marks the host as secure vs. insecure (ephemeral auth); optional body `vip` (default `false`) flags the host as VIP immediately (always warn on quota). Optional body `temporary` (boolean): when `true`, enables sliding expiry (2 hours since last successful host contact) by setting `expires_at`; each authenticated host request refreshes it. When `false`, clears any previous `expires_at`. Optional body `curl_insecure` (boolean): when `true`, bakes the host's signed wrapper config with `allow_insecure: true` (TLS verification bypass for sync), returns an installer command using `curl -k`, and makes the installer reuse `curl -k` for its own downloads. Optional body `reverse_dns_mode` (`global` | `enabled` | `disabled`) sets the per-host override for reverse DNS enforcement. Optional body `engines` selects `codex`, `claude`, or both for the host and drives installer minting mode. Optional body `duration_minutes` (integer 0–480) applies when `secure=false` and sets the initial insecure window duration (and persisted `insecure_window_minutes`) for the new/rotated host; when omitted, insecure registration keeps the default 30-minute provisioning window and stored 10-minute extension duration. Installer tokens capture the public base URL (trusted Host/proto or `PUBLIC_BASE_URL`) and return installer metadata with `mode` (`codex`, `claude`, `both`) plus a human label; creation fails if no valid base is available.
- `POST /admin/hosts/quick-register` — mint an insecure temporary throwaway host without a supplied FQDN. Body requires `engines` (`codex`, `claude`, or both) and accepts optional `duration_minutes` (integer 0–480). The server generates a short `tmp-YYYYMMDD-HHMMSS-xxxxxx` name, sets `secure=false`, `vip=false`, `curl_insecure=false`, and `expires_at` to 2 hours ahead, then returns the same host + installer metadata shape as `/admin/hosts/register`.
- `GET /admin/hosts/{id}/detail` — single-host detail card: the host row plus per-engine version summaries, available client versions, canonical auth metadata, and the global `auto_update_enabled` / `reverse_dns_enabled` / `inactivity_window_days` context. Unknown ids return `404 host_not_found`. This is the JSON payload behind the `/admin/hosts/{id}` page.
- `GET /admin/hosts/{id}/auth` — canonical digest/last refresh, recent digests, optional `auth` body (`?include_body=1`). Engine selection follows the same request-body/query/header resolution as host-facing routes and defaults to `codex`; the response includes the selected `engine`, engine-specific canonical digest/refresh, engine-scoped `recent_digests`, and the full host block still includes both Codex and Claude host fields (`last_refresh`/`auth_digest` and `claude_last_refresh`/`claude_auth_digest`, both client/wrapper version pairs, `claude_client_version_override`, and `engines`).
- `POST /admin/hosts/{id}/installer` — re-mint a single-use installer token for an existing host without rotating its API key. Optional body `engines` targets one or both engines, and optional body `curl_insecure` atomically updates the host's curl-insecure flag before minting so the returned copied command reflects the visible Host Detail toggle state. When omitted, the installer uses the host's stored engine set and current `curl_insecure` flag. The endpoint deletes prior pending installer tokens for that host and returns `{host, installer}` with the same installer metadata shape as registration. Hosts whose encrypted API key is unavailable return `409 host_api_key_unavailable`.
- `POST /admin/hosts/{id}/engines` — replace the host engine switch set. Body: `{engines:["codex"|"claude", ...]}`; at least one engine is required. The stored value is canonicalized as `codex`, `claude`, or `codex,claude`. Disabled engines are rejected on host-facing engine-scoped routes with `403 engine_disabled`; the next successful `cdx`/`clx` run reconciles the peer wrapper locally.
- `POST /admin/hosts/{id}/secure` — toggle the host’s security mode (`secure:
  true` keeps native auth locally; `false` makes the last exiting auth-aware
  cdx/clx process purge credentials while retaining explicit logout intent).
- `POST /admin/hosts/{id}/vip` — toggle VIP status (`vip: true` means quota kill switch is never enforced for this host; warn-only even when the global policy is deny).
- `POST /admin/hosts/{id}/scaling-exempt` — toggle `scaling_exempt` so the host is ignored by the scaling rules read/written through `/admin/scaling`.
- `POST /admin/hosts/{id}/auto-update` — set the per-host auto-update override. Body: `{override: true|false|null}`; `null` follows the fleet `/admin/auto-update` setting.
- `POST /admin/hosts/{id}/browseros-mcp` — toggle BrowserOS MCP for one host. Body: `{ "browseros_mcp": true|false }`. When enabled, the next Codex config sync injects `[mcp_servers.browseros]` for `http://127.0.0.1:9000/mcp` and `cdx` shows a BrowserOS startup chip.
- `POST /admin/hosts/{id}/insecure/enable` — for insecure hosts only; opens a sliding window where `/auth` calls are permitted. Optional JSON body `duration_minutes` sets the window length (integer 0–480, defaults to the last stored value or 10). Each `/auth` call extends the window by the configured duration.
- `POST /admin/hosts/{id}/insecure/disable` — closes the window immediately and clears any grace; retrieve-style insecure-window-gated calls are denied until re-enabled, while `/auth` `store` remains eligible under normal auth/IP/reverse-DNS/installation/runner validation rules.
- `GET /admin/insecure-approval` — returns `{ enabled: bool }` for the insecure-host approval gate (`/admin/policies`).
- `POST /admin/insecure-approval` — enable/disable insecure-host approval gate (`enabled` boolean).
- `GET /admin/insecure-approvals/pending` — list unresolved insecure approval requests for the admin queue. Returns `requests[]` with `id`, `host_id`, `fqdn`, `request_ip`, `requested_at`, `updated_at`, and `status`.
- `POST /admin/insecure-approvals/{id}/allow-domain` — approve a pending insecure-host request and add a domain auto-allow rule for the parent domain (auto-opens matching subdomains while its window is active). Pending requests older than five minutes are auto-denied before approval. Optional body `duration_minutes` overrides the host’s stored insecure window duration for this approval.
- `POST /admin/insecure-approvals/{id}/approve` — approve a pending insecure-host request (opens the host window using its configured duration). Pending requests older than five minutes are auto-denied before approval. Optional body `duration_minutes` overrides the host’s stored insecure window duration for this approval.
- `POST /admin/insecure-approvals/{id}/deny` — deny a pending insecure-host request (client remains blocked).
- `POST /admin/insecure-domain-allows/{id}/revoke` — revoke a domain auto-allow rule (future subdomain connections will require approval again).
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips`.
- `POST /admin/hosts/{id}/release-ip-binding` — clear the stored `ip4` and `ip6` bindings for a controlled network move while retaining the host's secure and roaming settings. The next valid host-authenticated request establishes the replacement binding. The release records the prior addresses in the admin audit trail.
- `POST /admin/hosts/{id}/reverse-dns` — set per-host reverse DNS enforcement (`mode`: `global` | `enabled` | `disabled`).
- `POST /admin/hosts/{id}/curl-insecure` — toggle TLS verification bypass for host sync (`allow` boolean). Future signed wrapper configs carry `allow_insecure: true`.
- `POST /admin/hosts/{id}/model` — set per-host model overrides. Body: `{model_override: string|null, reasoning_effort_override: string|null, claude_model_override: string|null}`. Null/empty values mean “Standard (global)”; Codex changes apply to the baked per-host `cdx` wrapper and Claude changes apply to the baked per-host `clx` wrapper. `model_override` is strict-allowlisted to `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`. Sol and Terra accept `low|medium|high|xhigh|max|ultra`; Luna stops at `max`; GPT-5.5, GPT-5.4, GPT-5.4 mini, and Spark accept `low|medium|high|xhigh`. The fleet default is `gpt-5.6-terra` with `medium` reasoning. Stored retired Codex ids are backfilled to Terra with the intentionally retained `high` migration effort.
- `POST /admin/hosts/{id}/codex-version` — set per-host Codex CLI version override. Body: `{selection: "global"|"<x.y.z>"}` (or `client_version_override` as a string/null). `global` clears the override and uses the fleet policy; explicit versions below the internal minimum `0.125.0` are coerced upward to `0.125.0`. `/auth` still reports `client_version_source=locked` for host overrides, but exact downgrade behavior only applies when `client_version_enforce_exact=true` (that is, the override is above the floor).
- `POST /admin/hosts/{id}/claude-version` — set per-host Claude Code CLI version override. Body: `{selection: "global"|"<x.y.z>"}` (or `claude_client_version_override` as a string/null). `global` clears the override and uses the fleet Claude policy. Explicit versions must be semantic versions accepted by `ClaudeVersionPolicy`; responses include the normalized override and effective version.
- `POST /admin/hosts/{id}/agents-version` — set per-host AGENTS.md version override. Body: `{selection: "global"|<version_id>}` (or `agents_document_id_override` as a numeric/null). `global` clears the override and uses the fleet setting; selecting a version pins this host to a specific AGENTS.md revision.
- `POST /admin/hosts/{id}/clear` — clears canonical auth state for the host across both engines. It resets `last_refresh`/`auth_digest` and `claude_last_refresh`/`claude_auth_digest`, deletes all `host_auth_states` rows for that host, and prunes all recent `host_auth_digests` rows for that host regardless of engine.
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — validate/store canonical `auth.json` (system or host-scoped). A configured, reachable runner and positive live verdict are mandatory.
- `POST /admin/auth/seed-command` — mint a one-time seed command (`curl -fsSL ... | bash`) that uploads local canonical credentials to the server. Body accepts `{engine: "codex"|"claude"}` and defaults to `codex`; Codex scripts read `~/.codex/auth.json`, while Claude scripts read `~/.claude/.credentials.json` including current Claude Code OAuth credentials. The script normalizes plain credential files by adding `last_refresh` when missing and prints server validation errors on upload failure. Returns `command`, `engine`, and `expires_at`. Tokens expire after `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900s). The server atomically reserves a token for one store attempt and releases it after ordinary validation/runner/store failure so the same recovery token can retry. An unsafe runner refresh/readback failure keeps the token consumed because the submitted refresh token may already be spent or its replacement may already be stored pending.
- `GET /seed/auth/{uuid}` — returns an engine-specific shell script that checks the token’s credential path (`~/.codex/auth.json` for Codex, `~/.claude/.credentials.json` for Claude) and posts it to `/seed/auth/{uuid}`. Intended for `curl -fsSL ... | bash`.
- `POST /seed/auth/{uuid}` — accepts a raw credential payload (or `{ "auth": ... }`), validates it for the token’s engine, stores canonical auth, and consumes the seed token after a successful store. A configured, reachable runner and positive live verdict are mandatory.
- `GET /seed/v2/auth/{uuid}` / `POST /seed/v2/auth/{uuid}` — aliases of the `/seed/auth/{uuid}` pair above; seed commands minted against the v2 URL keep working unchanged.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set persisted `api_disabled` flag (when true, all API routes return 503; `/admin/api/state` stays reachable so operators can re-enable).
- `GET /admin/openai/state` / `POST /admin/openai/state` — read/set persisted `openai_api_disabled` flag (toggles OpenAI-compatible API independently). Requires `settings` capability.
- `GET /admin/openai/keys` — list all OpenAI API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.
- `POST /admin/openai/keys` — create a new OpenAI API key. Body: `{name: string, expires_at?: string}`. Returns the full key (shown once) and the record. Keys use the `sk-codex-` prefix.
- `POST /admin/openai/keys/{id}/toggle` — enable or disable an OpenAI API key. Body: `{active: bool}`.
- `DELETE /admin/openai/keys/{id}` — delete an OpenAI API key.
- `GET /admin/claude/state` / `POST /admin/claude/state` — read/set persisted `claude_api_disabled` flag (toggles Anthropic-compatible API independently). Requires `settings` capability. See [Admin: Claude management](#admin-claude-management) for full details.
- `GET /admin/model-defaults/{engine}` — read the fleet CLI model defaults for `codex` or `claude`. Returns `{status:"ok", engine, model, reasoning_effort, catalog:[{model, persistent_efforts, default_effort}]}`; the catalog is the authoritative model-dependent selector contract. GET is read-only: if no engine config row exists it reports the effective catalog default (Codex Terra/medium or Claude Sonnet 5/high) without creating a row. Codex defaults are Sol/Terra/Luna/GPT-5.5/GPT-5.4/GPT-5.4 mini `medium` and Spark `high`; its accepted effort sets match the per-host contract above.
- `POST /admin/model-defaults/{engine}` — set the fleet CLI defaults. Strict body: `{model: string, reasoning_effort?: string|null}`. Omitted/null effort selects the model's `default_effort`; unsupported engines, models, efforts, or extra fields return HTTP 422 `validation_failed`. Codex persists `model` / `model_reasoning_effort`; Claude persists `model` / `effortLevel`. Claude persistent capabilities are Fable 5, Opus 5, Opus 4.8, and Sonnet 5 `low|medium|high|xhigh` (default `high`); Opus 4.7 has the same set with default `xhigh`; Sonnet 4.6 supports `low|medium|high` (default `high`); Haiku 4.5 has no effort value (`null`, so `effortLevel` is removed). This follows the native CLI settings schemas: Codex effort is model-dependent, while Claude Code persists only `low|medium|high|xhigh`; its `max` effort is session-only and is intentionally not offered here.
- `GET /admin/claude/keys` — list all Claude API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.
- `POST /admin/claude/keys` — create a new Claude API key. Body: `{name: string, expires_at?: string}`. Returns the full key (shown once) and the record. Keys use the `sk-claude-` prefix.
- `POST /admin/claude/keys/{id}/toggle` — enable or disable a Claude API key. Body: `{active: bool}`.
- `DELETE /admin/claude/keys/{id}` — delete a Claude API key.
- `GET /admin/claude/version` — Claude Code fleet version summary (the same shape the Codex version card uses).
- `POST /admin/claude/version` — set the fleet Claude Code version policy. Body `{selection: "latest"|"auto"|"<x.y.z>"}`; `latest`/`auto` clear the lock and refresh from upstream.
- `GET /admin/claude/config` — Claude `settings.json` builder state: the stored sub-blocks plus the baked document.
- `POST /admin/claude/config/render` — render `{settings}` into the baked `settings.json` without storing it.
- `POST /admin/claude/config/store` — store `{settings}` (optional `sha256` for compare-and-swap) as the served Claude config.
- Claude artifacts, where `{kind}` is `subagent`, `command`, or `output-style` (plural/alias spellings accepted); hosts read the same set through `/claude/{kind}`:
  - `GET /admin/claude/{kind}` — list artifacts of that kind, soft-deleted entries included.
  - `GET /admin/claude/{kind}/{slug}` — one artifact with its frontmatter and body; unknown slugs return `404 artifact_not_found`.
  - `POST /admin/claude/{kind}/store` — create/update an artifact; the kind's required frontmatter keys (`name`/`description` for subagents, `description` for commands) are enforced.
  - `DELETE /admin/claude/{kind}/{slug}` — soft-delete an artifact so hosts retrieve `status:deleted`.
- `GET /admin/claude/settings` / `POST /admin/claude/settings` — read/set the separate Anthropic-compatible API proxy defaults (`default_model`, `max_tokens`). These values do not change the Claude Code fleet `model` / `effortLevel` managed by `/admin/model-defaults/claude`. Requires `settings` capability. Supported models: `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set ChatGPT quota policy (`hard_fail` boolean), the warn/kill threshold (`limit_percent`, integer 50–100), and optional weekly partitioning (`week_partition`: `0|off`, `7`, or `5`). When `false`, `cdx` warns once usage meets the configured limit but still launches Codex; when `true`, exceeding the limit blocks execution. A non-zero `week_partition` adds a daily allowance bar in `cdx` (derived from the weekly window) that obeys the same warn/deny policy.
- `GET /admin/cdx-silent` / `POST /admin/cdx-silent` — read/set fleet-wide wrapper quiet mode (`silent` boolean). When enabled, `cdx` suppresses boot info/warn logs and only emits errors.
- `GET /admin/api-keys-in-chat` / `POST /admin/api-keys-in-chat` — read/set the default-off cross-engine chat-key policy (`enabled` boolean). When enabled, served AGENTS.md/CLAUDE.md tells agents to accept operator-supplied API keys without generic security lectures while avoiding unnecessary echoing, persistence, or use outside the requested task.
- `GET /admin/agents-generation-mode` / `POST /admin/agents-generation-mode` — read/set the fleet-wide master switch for how the canonical middle of AGENTS.md/CLAUDE.md is produced. Body/response `mode` is one of `managed` (default: the composed policy modules plus custom instructions), `manual` (the stored document verbatim), or `off` (the generated modules are dropped and only the operator's custom instructions remain). Unknown values are rejected with `422 validation_failed`; an unrecognized *stored* value reads back as `managed`, so a settings row this build cannot parse never strips prose fleet-wide. The switch is applied when a document is rendered, not when it is stored — `POST /admin/agents/store` keeps writing the full module selection at every mode, so flipping back restores it without a new version. No position suppresses the mandatory policy block or the managed feature block. Also reported as `generation_mode` on `GET /admin/agents`.
- `GET /admin/reverse-dns` / `POST /admin/reverse-dns` — read/set fleet-wide reverse DNS enforcement (`enabled` boolean). When enabled (or per-host override enabled), `/auth` requires a forward A/AAAA match and reverse PTR match for the calling IP.
- `GET /admin/theme` / `POST /admin/theme` — read/set the stored admin UI theme (`auto` default). The Svelte console renders `auto`/`light`/`dark` as neutral system/light/dark modes; historical `auto-pink`, `bright-pink`, and `dark-pink` values remain accepted for compatibility and are normalized client-side. The selected value also rides along in the `/auth` `versions` block as `admin_theme`.
- `GET /admin/auto-update` / `POST /admin/auto-update` — read/set the fleet auto-update flag (`enabled` boolean). Per-host `/admin/hosts/{id}/auto-update` overrides win over it.
- `GET /admin/log-retention` / `POST /admin/log-retention` — read/set log pruning: `enabled` plus `days_logs` (default 90), `days_mcp` (90), `days_events` (30), and `days_graph_stats` (180), each clamped to `1..365`.
- `GET /admin/scaling` / `POST /admin/scaling` — read the scaling status and store the scaling rules; invalid rules return `422 validation_failed` with per-rule errors. Hosts flagged `scaling_exempt` through `/admin/hosts/{id}/scaling-exempt` are excluded.
- `POST /admin/prune-policy` — set host inactivity pruning window. Body `{inactivity_days: 0..60}`.
- `POST /admin/codex-version` — set the fleet Codex CLI version policy. Body: `{selection: "latest"|"<x.y.z>"}`. `latest` keeps the GitHub-latest flow; explicit versions below the internal minimum `0.125.0` are coerced upward to `0.125.0`. `/versions` continues to report `client_version_source=locked` for explicit fleet selections, but exact downgrade behavior only applies when `client_version_enforce_exact=true` (that is, the fleet pin is above the floor).
- `GET /admin/logs?limit=` — recent audit events.
- `GET /admin/mcp/logs?limit=` — recent MCP tool calls (max 500).
- `GET /admin/runner` — runner config/telemetry (configured flag, runner URL, readiness detail, combined state, and engine-scoped telemetry at `runner.engines.codex` / `runner.engines.claude` with `state`, `last_check`, `last_ok`, `last_fail`, `last_run`, and `last_error`). Persisted telemetry is projected as `idle` with cleared timestamps for an engine that has no currently verified, structurally valid, distributable canonical auth; stale rows from a reused database therefore cannot render a false healthy badge. `POST /admin/runner/run` verifies the latest Codex canonical auth payload. `POST /admin/runner/run-claude` verifies the latest Claude canonical auth payload via the runner's `/verify-claude` path; native Claude Code OAuth payloads are verified by a real Claude CLI probe, not by sending the OAuth access token as a public API key.
- `POST /admin/versions/check` — refresh GitHub client release cache.
- `GET /admin/chatgpt/usage[?force=1]` — account-level ChatGPT `/wham/usage` snapshot using canonical `auth.json` token (5-minute cooldown unless `force`). The default Compose `quota-cron` worker refreshes this stored snapshot at boot and then every `CHATGPT_USAGE_CRON_INTERVAL` seconds (default 900); host `/auth` retrieval only reads the stored result.
- `GET /admin/chatgpt/usage/history?days=60` — quota history for dashboard graphs (normal/spark lane, 5-hour + weekly windows), capped to the past 180 days. History is served from the set-aside graph snapshot store so the charts survive verbose log cleanup. Query params: `days` (1..180), optional `from`/`until` (RFC3339/date strings), optional `interval=raw|hour|day`, optional `lane=normal|spark|both`, optional `window=primary|secondary|both`. Returns compatibility `points` and normalized `series` plus `days`, `since`, `from`, `until`, `interval`, `lane`, `window`.
- `POST /admin/chatgpt/usage/refresh` — force-refresh ChatGPT usage snapshot (bypasses cooldown).
- `GET /admin/agents` — fetch AGENTS.md serving state for the dashboard. Returns canonical AGENTS state: `status`, `mode` (`latest` | `locked`), `active_id`, `served_id`, `latest_id`, `backup_limit` (`null` = unlimited historical backups), served base-document `sha256` + `updated_at` + `size_bytes` + `content`, and `versions` (id/sha/created/updated/size + flags). `locked` means the fleet is pinned to a specific historical version; `latest` means serving follows the newest stored edition. This endpoint never expands host-specific features; host-facing `/agents/retrieve` appends the single managed-feature block described above.
- `POST /admin/agents/compose` — normalize a toggle-builder composition and render its canonical base document without storing it. The three fleet identity, safety-floor, and hard-stop sections are mandatory; optional operating modules and custom Markdown are returned with the normalized composition and digest. Also returns `provenance`: the module and custom-instruction blocks in document order, each with the `##` headings its own Markdown contains. Composing knows nothing of a host or a posture, so it describes no policy or feature blocks — those come from `POST /admin/agents/render`.
- `POST /admin/agents/render` — render an unsaved raw or composed draft through the exact host- and engine-specific managed renderer. Body: `{ host_id, engine?, content?, composition?, security_levels? }`. This is the preview counterpart to host retrieval and has no sync side effects. Two preview-only fields accompany the document, and are deliberately absent from the serve path: `provenance`, every highlightable block in document order (`policy:*`, `module:*`, `custom_instructions`, `feature:*`, or a single `legacy_document` for an un-composed body), and `axis_sections`, which names the policy sections each security axis currently contributes text to. Attribution is section-level: one axis routinely reaches two sections at once, and a single Hard Stop bullet can be the joint work of several, so neither field claims sole ownership of any sentence.
- `GET /admin/agents/render?host_id={id}&engine=codex|claude` — read-only preview of the exact current document the selected host would receive. Requires an enrolled host with the requested engine; defaults `engine` to `codex`. Returns the host identity, effective document metadata/content, base and managed digests, and managed-feature `sections`. It uses the same server renderer as `/agents/retrieve`, but does not record a host sync or issue a wrapper-side effect.
- `GET /admin/agents/versions/{id}` — fetch one historical AGENTS.md version with full `content`, `sha256`, timestamps, `size_bytes`, and `is_latest` / `is_active` / `is_served` flags for read-only admin inspection.
- `POST /admin/agents/store` — create a new AGENTS.md edition. Body: `content` (string markdown), optional `sha256` check (64-hex). Returns `status` (`created` | `updated` | `unchanged`), `version_id`, `sha256`, `updated_at`, `size_bytes`, and optional `pruned_count` when retention cleanup deleted older unprotected backups. Overlapping identical saves are deduped against the current latest version under a DB lock, so the endpoint returns `unchanged` instead of spraying duplicate history rows.
- `POST /admin/agents/retention` — set AGENTS historical backup retention. Body: `{ backup_limit: 0..200|null }`; `0`/`null` disables pruning and restores unlimited history. Response returns `backup_limit` (`null` when unlimited) plus `pruned_count`. Retention counts only historical backups: the newest latest draft is always kept, and the currently served fleet version plus any host-pinned versions are protected from automatic deletion even if that temporarily exceeds the configured cap.
- `GET /admin/agent-policy-profiles` — list named fleet security postures with their assigned host ids, plus the axis/preset `catalog` the console renders sliders from.
- `POST /admin/agent-policy-profiles` — create a profile. Body: `{ name, description?, levels? }`; `levels` is normalized against the axis registry, so unknown axes are dropped and missing ones fall back to the fleet default vector.
- `POST /admin/agent-policy-profiles/:id` — update a profile's `name`, `description`, or `levels`. Bumps the profile's own `revision`; the agents document's version history is unaffected, because prose and posture are versioned separately.
- `DELETE /admin/agent-policy-profiles/:id` — delete a profile and every host assignment pointing at it. Rejects the fleet default, which is the fallback every unassigned host resolves to.
- `POST /admin/agent-policy-profiles/:id/default` — make this profile the fleet default, clearing the flag from whichever profile held it.
- `POST /admin/agent-policy-profiles/assign` — assign a host to a profile. Body: `{ host_id, profile_id }`; `profile_id: null` clears the assignment back to the fleet default. Orthogonal to `agents_document_id_override`, which pins which prose document a host receives.
- `GET /admin/agent-policy-profiles/enforcement?host_id=` — read-only projection of a host's resolved posture onto engine config (`approval_policy`, `sandbox_mode`, `sandbox_workspace_write.network_access`, `web_search`, `features.guardian_approval`, Claude `permissions.defaultMode`), each naming the axis currently governing it, plus the keys deliberately not enforced and why.
- `POST /admin/agents/serve` — set the serving mode. Body: `{ mode: "latest" | "locked", version_id?: number }`. `mode=latest` follows newest editions; `mode=locked` pins the served version to `version_id`.
- `POST /admin/agents/revert` — create a new latest AGENTS.md edition by cloning a historical version. Body: `{ version_id: number }`. Revert preserves immutable history, creates a fresh newest row with the selected content, resets serving mode to `latest` so the new latest version is also what the fleet receives, and may return `pruned_count` when retention cleanup deletes older unprotected backups.
- `DELETE /admin/agents/versions/{id}` — delete a non-served AGENTS.md edition by id.
- `GET /admin/config` — fetch canonical `config.toml` metadata + `content` + `settings` (the structured builder payload). Returns `status` (`missing` when unset), `sha256`, `updated_at`, `size_bytes`. Normalized settings include root `personality` (`friendly|pragmatic|none`, default `friendly`), default-on feature flags `features.apps`, `features.fast_mode`, `features.memories`, and `features.multi_agent` when unset, and builder-default disabled flags `features.guardian_approval`, `features.js_repl`, `features.tui_app_server`, and `features.prevent_idle_sleep` unless explicitly enabled.
- `POST /admin/config/render` — render a `settings` payload into TOML without persisting it. Returns `content`, `sha256`, `size_bytes`, and the normalized `settings` (including root `personality`, default `friendly`, default-on `features.apps` / `features.fast_mode` / `features.memories` / `features.multi_agent` when unset, and builder-default disabled `features.guardian_approval` / `features.js_repl` / `features.tui_app_server` / `features.prevent_idle_sleep` unless explicitly enabled).
- `POST /admin/config/store` — persist canonical `config.toml` built from the provided `settings` payload. Optional `sha256` acts like an optimistic concurrency check: when a config already exists, the provided sha must match the currently saved config sha (reload before saving when it doesn’t). Returns `status` (`created` | `updated` | `unchanged`), `sha256`, `updated_at`, `size_bytes`, `content`, and normalized `settings` (including root `personality`, default `friendly`, default-on `features.apps` / `features.fast_mode` / `features.memories` / `features.multi_agent` when unset, and builder-default disabled `features.guardian_approval` / `features.js_repl` / `features.tui_app_server` / `features.prevent_idle_sleep` unless explicitly enabled).
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
  hard, including host and project memories. There is no trash, restore, or
  body rollback.
- `POST /admin/memories/shared/{recordId}/append` — append to a shared document
  through the same row-lock/chunk/revision path as `shared_memory_append`, so
  concurrent additions are serialized rather than lost. The strict body is
  `{content:string}`; other keys fail validation. Returns the updated normalized
  memory with `status:"appended"` and the new HTTP `ETag`.
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
  - `POST /admin/secrets` — `{slug, name, value, description?, engine?, tags?}`,
    responds `201`. `engine` is nullable and null means every engine. A create
    against a soft-deleted slug revives and rotates that row rather than
    failing, since the unique key is on `slug` alone.
  - `PATCH /admin/secrets/{id}` — `{name?, value?, description?, engine?, tags?}`.
    `slug` is rejected: it is the lookup key agents hold, so a rename would
    silently break them. Responds `{secret, rotated}`, where `rotated` is true
    only when the value genuinely differs from the stored one.
  - `DELETE /admin/secrets/{id}` — soft delete; the slug stays reserved and can
    be revived by a later create.
  - `POST /admin/secrets/{id}/reveal` — the only endpoint returning a plaintext
    value, as `{secret, value}`. A `POST` deliberately: a `GET` can be
    prefetched by a browser, cached by an intermediary, and replayed out of
    history. Records a non-broadcast `secret.revealed` admin event.
- `GET /admin/skills` — list stored skills (slug, sha256, display name, description, timestamps) plus canonical `uri` / `canonical_uri`, `managed`, and nullable source provenance. `description` is the persisted short summary used by the runtime AGENTS Skills block when present. Code-managed and source-owned skills are returned with `managed:true`; imported rows use `source_type:"github:mattpocock/skills"`.
- `GET /admin/skills/{slug}` — browser/API split. Browser requests (`Accept: text/html`) receive the admin SPA shell for the dedicated skill workspace page; JSON requests (`Accept: application/json`) fetch full skill content (manifest + metadata, including canonical skill URI, invocation policy, and source provenance).
- `POST /admin/skills/generate` — admin-only runner-backed draft generation. Body: `prompt` (required string) and optional `slug_hint`. Returns a structured skill draft (`slug`, `display_name`, `description`, `tags`, `what`, `when`, `steps`) plus a server-built canonical `manifest`. This endpoint never persists the skill; admins must still call `POST /admin/skills/store` after review. Returns `503` when canonical auth or the runner is unavailable, and `502` when the runner returns unusable output.
- `POST /admin/skills/assist` — admin-only runner-backed conversational draft refinement. Body: `messages` (required non-empty array of `{role:"user"|"assistant", content}`), `skill` (current structured draft fields), and optional `mode` (`new|edit`, default `new`). Returns `assistant_message`, normalized draft fields (`slug`, `display_name`, `description`, `tags`, `what`, `when`, `steps`), canonical `manifest`, `changed_fields`, and runner metadata. Edit-mode requests lock the existing slug even if the runner suggests a rename. This endpoint never persists the skill; admins still save through `POST /admin/skills/store`.
- `POST /admin/skills/store` — create/update a skill (body: `slug`, `manifest`, optional `display_name`/`description`/`sha256`; sha computed from manifest when omitted). Code-managed slugs and source-owned rows cannot be overwritten directly.
- `DELETE /admin/skills/{slug}` — retire a locally authored skill (marks `deleted_at`; hosts remove it on next sync). Code-managed and source-owned skills cannot be deleted through this route.
- `GET /admin/skill-sources/mattpocock` — any authenticated admin role may read source state `{source,repository,ref,enabled,auto_update,status,revision,upstream_version,skill_count,file_count,last_checked_at,last_synced_at,last_error}`. Constants are `source:"github:mattpocock/skills"`, repository `https://github.com/mattpocock/skills`, and `ref:"main"`; `status` is `disabled|ok|error`. Inclusion defaults off, fresh source state defaults auto-update on, an auto-update preference configured while disabled is preserved on enable, and no outbound request occurs while inclusion is off.
- `POST /admin/skill-sources/mattpocock` — owner/admin only. The non-empty body accepts one or both strict booleans `{enabled?,auto_update?}` and rejects unknown keys; returns the same state. Turning inclusion off soft-deletes/hides only rows owned by this source; cached rows, `skill_files`, and last-known-good metadata remain, Codex stops listing them immediately, and Claude prunes their fleet-owned directories on its next bootstrap. A later enable validates that complete cached revision and restores it without a GitHub request; a missing, incomplete, or damaged cache instead triggers a fresh import from the immutable upstream SHA. Turning only auto-update off pins the last-known-good revision.
- `POST /admin/skill-sources/mattpocock/refresh` — owner/admin only, with no request body. Force a manual check for an enabled source and return the same state on success. Normal auto-update checks every six hours. A refresh resolves `main` to a commit SHA, imports only the exact `.claude-plugin/plugin.json` paths, fetches all content plus root `LICENSE` at that SHA, validates paths/digests/frontmatter, and commits the complete set atomically. The MIT notice is stored in every bundle as `LICENSE.mattpocock`; a failed check records the error/time but keeps the previous served revision.
- Projects module admin routes:
  - `GET /admin/projects/state` — returns `{ enabled, updated_at, managed_skill:{slug,display_name,description} }`.
  - `POST /admin/projects/state` — body `{ enabled: bool }`; persists module state under `versions.projects_module_enabled`.
  - `GET /admin/projects/feedback` — list feedback across all projects as `{ project:null, feedback:[...] }`.
  - `GET /admin/projects` / `POST /admin/projects` / `GET /admin/projects/{slug}` mirror the host project list/create/detail surface.
  - `POST /admin/projects/{slug}/assist` — admin-only runner-backed project metadata draft. Uses canonical auth plus the current project snapshot (about, roster, recent notes/todos/files/feedback/activity) to suggest improved `about.title`, `about.name`, `about.description`, and optional `roster_markdown`. Returns draft-only data (`assistant_message`, sparse `about`, optional `roster_markdown`, `changed_fields`, runner metadata) and never persists changes; the operator must still save About/Roster explicitly. Returns `503` when canonical auth or the runner is unavailable, and `502` when the runner returns unusable output.
  - `DELETE /admin/projects/{slug}` — hard-deletes the project and all dependent notes/todos/files/feedback/memories/events via FK cascade; returns `{ deleted: slug }`.
  - `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster` and `GET /admin/projects/{slug}/changes` mirror the host `/projects/{slug}/*` surface, as do the note/todo/file/feedback subroutes:
    - Notes: `GET /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes/{id}`, `DELETE /admin/projects/{slug}/notes/{id}`.
    - Todos: `GET /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos/{id}`, `POST /admin/projects/{slug}/todos/{id}/done`, `POST /admin/projects/{slug}/todos/{id}/undone`, `DELETE /admin/projects/{slug}/todos/{id}`.
    - Files: `GET /admin/projects/{slug}/files`, `POST /admin/projects/{slug}/files`, `DELETE /admin/projects/{slug}/files/{id}`.
    - Feedback: `GET /admin/projects/{slug}/feedback`, `POST /admin/projects/{slug}/feedback`.

## Auth + IP rules

- API key is bound to the first caller IP, plus one secondary IP when the host is dual-stack (one IPv4 + one IPv6); subsequent calls from new IPs are blocked unless `allow_roaming_ips` is enabled via admin or `?force=1` on `DELETE /auth`.
- Insecure hosts auto-rebind to the current caller IP while their insecure window is active, so reinstall/rotate flows don’t get stuck on “IP bound” if the host comes back on a new address during that window.
- Admin endpoints require the admin session cookie. The API never checks a client certificate: `auth-mtls` parses `X-MTLS-Fingerprint`/`-Subject`/`-Issuer` into `req.mtls` and no route reads it, so `X-MTLS-Present` changes nothing. The certificate gate belongs to the optional `caddy` compose profile, which is not started by a plain `docker compose up`; without it (or another proxy doing the same) lock down `/admin` via VPN or firewall.
- Runner IP bypass: when `AUTH_RUNNER_IP_BYPASS=1` and `AUTH_RUNNER_BYPASS_SUBNETS` contains CIDRs, runner-originated `/auth` validation can proceed without rebinding the stored host IP (logged as `auth.runner_ip_bypass`).
- Runner auth: when `AUTH_RUNNER_SHARED_SECRET` is set on API and `RUNNER_SHARED_SECRET` is set on the runner, API calls to runner include `X-Runner-Auth`; runner rejects missing/invalid secrets with HTTP 401.
- Encryption key: either `ENCRYPTION_ACTIVE_KEY` or the legacy `AUTH_ENCRYPTION_KEY` must hold 32 base64-encoded raw bytes. With neither set the env schema fails and the API does not start, keyring vars alone included.

## Request rates

The orchestrator does not meter request frequency and does not generate local rate-limit responses. Authentication, host/IP rules, insecure-host windows, and API kill switches remain enforced. Deployments that require volumetric controls must provide them at the trusted reverse proxy or network edge.

## Anthropic-compatible API

- `POST /anthropic/v1/messages` — Anthropic-compatible Messages API. `messages[].content` may be a plain string or an Anthropic-style content-block array. Non-streaming returns a standard `message` object. Streaming emits `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, and `message_stop` SSE events. `model` must be one of the supported Claude models returned by `GET /anthropic/v1/models`; when omitted, the API resolves the default from the saved main config model. Supported body parameters: `messages` (required), `model` (optional), `system` (optional string or text-block array), `stream` (optional bool), `max_tokens` (optional int; when present must be an integer >= 1, else 400 `invalid_max_tokens`), `temperature` (optional float 0-1), `top_p` (optional float 0-1), `top_k` (optional int), `stop_sequences` (optional string array). An unknown `model` returns 404 `not_found_error`; an admin-disabled one returns 403 `permission_error`.
- `POST /anthropic/v1/completions` — legacy Anthropic text completions endpoint. `model` uses the same strict allowlist and default-resolution behavior as messages.
- `GET /anthropic/v1/models` — lists the supported Claude model ids from the shared config/model allowlist used by the Anthropic-compatible API: `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. Response uses the Anthropic Models API envelope (`data[].type`/`display_name`/`created_at` plus `has_more`/`first_id`/`last_id`); the OpenAI-shaped `object`/`created`/`owned_by` fields are retained as deprecated aliases.
- `GET /anthropic/v1/models/{model_id}` — retrieves a single model object. Legacy ids resolve to their current-generation replacement; unknown ids return 404 `not_found_error`.
- `POST /anthropic/v1/responses` — Minimal Responses API compatibility adapter for non-streaming clients. Body: `{ input: string|array, instructions?: string, model?: string, stream?: bool }`. When `stream` is `true`, the API returns HTTP 400 with code `unsupported_stream`. The `input` parameter accepts a plain string, a bare content-part array (e.g. `[{type:"input_text", text:"..."}]`), or a message-style array (e.g. `[{type:"message", role:"user", content:"..."}]`). Optional `instructions` are injected as a `system` message. Maps the request onto the Messages backend and returns an OpenAI-compatible `response` object with `output[0].content[0].type="output_text"`. Model uses the same Claude model allowlist; omitted models resolve to Sonnet 5.
- `POST /anthropic/v1/embeddings` — Placeholder endpoint. Anthropic does not support embeddings; returns HTTP 501 with `{type: "error", error: {type: "not_implemented", message: "Embeddings are not supported by the Anthropic backend", code: "not_implemented"}}`.
- `OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions`, `OPTIONS /anthropic/v1/responses`, `OPTIONS /anthropic/v1/embeddings` — CORS preflight for Anthropic routes.

## Admin access control

- Admin routes are protected by the admin session cookie (`requireAdmin`). Client certificates are enforced one layer out, by the optional `caddy` profile, which rejects `/admin*` without a validated cert and injects the `X-MTLS-*` headers. `ADMIN_ACCESS_MODE` (`mtls` default, `cookie`, `open`) is read only by `/cli/auth/verify`, where anything but `open` requires an admin session; it does not gate `/admin/*`. Passkey/WebAuthn login issues the same session cookie.
- WebAuthn config:
  - `ADMIN_WEBAUTHN_RP_ID` overrides RP ID; otherwise the app prefers the `PUBLIC_BASE_URL` host before falling back to the trusted request host. Setting it also requires `ADMIN_WEBAUTHN_ORIGIN`: the env schema rejects the RP ID on its own, so the API fails to start.
  - `ADMIN_WEBAUTHN_RP_NAME` overrides RP display name.
  - `ADMIN_WEBAUTHN_ORIGIN` overrides the exact expected origin; otherwise the app prefers `PUBLIC_BASE_URL` before deriving origin from the trusted request scheme/host.
- Userless bootstrap: when no active admin users exist, the admin UI behaves as it does today (no login enforcement). Creating the first active admin enables login + role checks.
- Roles and privileges:
  - `admin`: full access, including user management and wipe.
  - `fleet_operator`: can add/remove hosts and change admin settings.
  - `trusted_user`: can activate insecure hosts (open/close windows).
  - `user`: read-only access to admin views.

## Anthropic-compatible API

Authentication: `Authorization: Bearer sk-claude-...` or `x-api-key: sk-claude-...` header. Runtime validation is engine-scoped: Anthropic-compatible routes accept only Claude keys from `/admin/claude/keys`, while OpenAI-compatible routes accept only Codex keys from `/admin/openai/keys`.

### Endpoints

- `POST /anthropic/v1/messages` — Send messages to Claude. Body: `{ messages: [{role: "user"|"assistant", content: string|array}], model: string, system?: string|array, stream?: bool, max_tokens?: int, temperature?: float, top_p?: float, top_k?: int }`. `system` accepts a plain string or an Anthropic text-block array (flattened; `cache_control` accepted and ignored). Content can be a string or an array of content blocks: `{type: "text", text: "..."}` for text, `{type: "image", source: {type: "base64"|"url", media_type?: string, data?: string, url?: string}}` for images. System messages in the `messages` array are extracted and handled separately per Anthropic convention. Supported models: `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. Returns Anthropic message format: `{id, type: "message", role: "assistant", content: [{type: "text", text: "..."}], model, stop_reason, stop_sequence, usage: {input_tokens, output_tokens}}`. When `stream: true`, returns Server-Sent Events with event types: `message_start`, `content_block_start`, `content_block_delta` (with `text_delta`), `content_block_stop`, `message_delta`, `message_stop`.

- `POST /anthropic/v1/completions` — Text completion endpoint. Body: `{ prompt: string, model?: string }`. Returns: `{id, type: "completion", completion: string, model, stop_reason, usage: {input_tokens, output_tokens}}`.

- `GET /anthropic/v1/models` — List available Claude models. Returns: `{data: [{type: "model", id, display_name, created_at}], has_more: false, first_id, last_id}` (plus deprecated OpenAI-shaped `object`/`created`/`owned_by` aliases).

- `GET /anthropic/v1/models/{model_id}` — Retrieve one model object; unknown ids return 404 `not_found_error`.

- `OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions` — CORS preflight. Returns 204 with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type, Authorization, x-api-key, anthropic-version`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`.

### Admin: Claude management

- `GET /admin/claude/keys` — List all Claude API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.

- `POST /admin/claude/keys` — Create a new Claude API key. Body: `{name: string, expires_at?: string}`. Returns the full key (shown once) and the record. Keys use the `sk-claude-` prefix.

- `POST /admin/claude/keys/{id}/toggle` — Enable or disable a Claude API key. Body: `{active: bool}`.

- `DELETE /admin/claude/keys/{id}` — Delete a Claude API key.

- `GET /admin/claude/state` — Get Claude API enabled/disabled state. Returns `{status, data: {disabled: bool}}`.

- `POST /admin/claude/state` — Toggle Claude API enabled/disabled. Body: `{disabled: bool}`. Requires `settings` capability.

- `GET /admin/model-defaults/{engine}` / `POST /admin/model-defaults/{engine}` with `engine=claude` — Read/set the Claude Code fleet `settings.json` defaults (`model`, native `effortLevel`). This is the CLI fleet setting, not the Anthropic-compatible proxy default. See the general admin endpoint contract above for the request, response, model capabilities, and 422 validation behavior.

- `GET /admin/claude/settings` — Get the separate Anthropic-compatible API proxy defaults. Returns `{status, data: {default_model, max_tokens, disabled}}`.

- `POST /admin/claude/settings` — Update the separate Anthropic-compatible API proxy defaults. Body: `{default_model?: string, max_tokens?: int}`. Requires `settings` capability. Supported models: `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.

### Anthropic error format

Errors return: `{type: "error", error: {type: string, message: string, code?: string}}` with appropriate HTTP status codes:
- 400: `invalid_request_error` — Missing or invalid parameters
- 401: `authentication_error` — Missing or invalid API key
- 429: `rate_limit_error` — an upstream provider reported quota pressure; the gateway does not originate this response
- 502: `api_error` — Backend/runner communication failure
- 503: `api_error` — Backend not configured or API disabled by administrator

## Agent Messaging

Agent Messaging is the agent-to-agent bus shared by Codex and Claude. Its
`agent_messaging_enabled` fleet switch is seeded off. A sender and target are
eligible only when the fleet switch is on, both addresses are enabled and
unarchived, both hosts are active and secure, each host's per-host Agent
Messaging switch is on, and each address's engine remains in that host's
enabled engine set. These checks are repeated inside the send, bind, claim, and
acknowledgement transactions. The matrix is complete: Codex to Codex, Codex to
Claude, Claude to Codex, and Claude to Claude all use the same contract.

An agent receives a stable canonical address (`agent:<uuid>`) from the shared
`POST /host/agent-sessions` lifecycle registration. The address is rebound on a
native resume, or reused for the latest dormant matching host/user/engine/cwd
identity with `continuity:reset`; concurrent live sessions never share one
binding. `POST /host/agent-sessions/{id}/heartbeat` carries adapter capability,
receive readiness, upstream-session continuity, and a generation fence.
`POST /host/agent-sessions/{id}/finish` unbinds the address, clears receive
capability, and leaves it `resumable` when an upstream session is known or
`offline` otherwise. The scoped bridge bearer is kept by `cxx` and proxied to
the engine over its private Unix socket.

Session-bound operations require `X-Agent-Bridge-Token`:

- `POST /host/agent-sessions/{id}/agent-messaging/list` — discover eligible
  peer addresses, optionally filtered by engine or host.
- `POST /host/agent-sessions/{id}/agent-messaging/send` — enqueue a new message
  or request. Body includes `to`, UTF-8 `content`, UUID `client_message_id`, and
  optional `conversation_id`, `ttl_seconds`, and `kind` (`message|request`).
- `POST /host/agent-sessions/{id}/agent-messaging/reply` — append a reply to a
  message using a new sender-scoped idempotency UUID.
- `POST /host/agent-sessions/{id}/agent-messaging/wait` — conversation-ordered
  long poll (`seconds` 0..25, default 20) after a sequence cursor.
- `POST /host/agent-sessions/{id}/agent-messaging/message` — fetch one
  participant-visible message by UUID.
- `POST /host/agent-sessions/{id}/agent-messaging/cancel` — cancel an open
  participant conversation and all queued/leased messages in it.
- `POST /host/agent-sessions/{id}/agent-messaging/call/open` — mint a `#call`
  rendezvous PIN (four digits, fleet-unique while live, `ttl_seconds` 60..3600,
  default 600) bound to the caller's own address, returned alongside that address
  as `self`. Idempotent while a PIN is live (`reused: true`).
- `POST /host/agent-sessions/{id}/agent-messaging/call/join` — redeem a PIN:
  resolve the opener, open the conversation, queue the opening message and
  consume the PIN, all in one transaction. A join that fails validation, targets
  itself, or finds an ineligible opener leaves the PIN live.
- `POST /host/agent-sessions/{id}/agent-messaging/bind` — heartbeat/bind the
  native adapter with `binding_generation`, continuity, upstream session, and
  receive-capability state.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/claim` — claim one
  delivery with an idempotent UUID and optional 0..25 second long poll.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/renew`
  — extend the owned 60-second lease.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/ack` —
  report `accepted`, `completed`, `retry`, `dead`, or `ambiguous` for the owned
  claim.

One outbound-only background relay is registered per host user. Registration
uses normal host API-key/IP policy and returns a generation-fenced 15-minute
bearer; subsequent calls require `X-Agent-Relay-Token`. The relay never opens a
listener and never claims an address while its interactive, receive-capable
session is attached:

- `POST /host/agent-relays/register` — register/replace the per-user relay and
  return its id, generation, token, expiry, and polling interval.
- `POST /host/agent-relays/{id}/heartbeat` — renew relay heartbeat and token
  expiry.
- `POST /host/agent-relays/{id}/stop` — stop the generation and erase its token.
- `POST /host/agent-relays/{id}/deliveries/claim` — long-poll for one eligible
  dormant address delivery.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/renew` — extend the
  relay-owned lease.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/reply` — atomically add
  the delivery reply while preserving claim and native-session continuity.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/ack` — acknowledge the
  relay-owned delivery with the same outcome vocabulary as session delivery.

Delivery is ordered at least once. A monotonic dispatch key and conversation
sequence provide per-target FIFO; a delayed retry remains head-of-line, and no
target may have more than one leased or accepted message. Claims and sender
`client_message_id` values are idempotent. Leases last 60 seconds, retries use
bounded exponential backoff, and the twelfth attempt is terminal `dead`.
Messages are at most 32 KiB UTF-8. TTL defaults to 24 hours and accepts 60
seconds through seven days. Expired queued/leased rows become `expired`.

Acceptance is a deliberate uncertainty boundary: after the target has accepted
work, a lost completion acknowledgement, eligibility shutdown, or expired
accepted lease becomes `ambiguous` rather than being replayed automatically.
Only an owner/admin may explicitly redrive a `dead` or `ambiguous` message; the
redrive is a new queued row and conversation sequence linked by
`redrive_of_message_id`, while the terminal original remains unchanged.

Message bodies and recorded delivery errors are secretbox-encrypted. Admin
address, conversation, and message listings return metadata only. Any active
authenticated admin role, including viewer/legacy read-only roles, may read
that metadata; every mutation and plaintext reveal requires `owner` or `admin`:

- `GET /admin/agent-messaging/state` — fleet state, eligible/live counts,
  queues, and all four engine-direction summaries.
- `POST /admin/agent-messaging/state` — toggle the default-off master switch.
- `GET /admin/agent-messaging` — SPA/JSON address inventory compatibility path.
- `GET /admin/agent-messaging/addresses` — address/host eligibility and queue
  depth without message content.
- `PATCH /admin/agent-messaging/addresses/{id}` — set or clear the unique
  human alias.
- `POST /admin/agent-messaging/addresses/{id}/enabled` — enable/disable one
  address; enabling rechecks every upstream gate.
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

## Agent Portal

The portal is a separate mobile-first user surface at `/go`. Its persistent
`agent_portal_enabled` switch is seeded off. Portal users default enabled and
see every eligible active root session across the fleet; a finished session is
read-only until the 24-hour retention purge. Nothing is pushed anywhere: each
user reaches the portal through their own permanent bookmarked link, and
lifecycle and attention notices are recorded there rather than delivered out.

Every `/go/api/*` route is same-origin only and never inherits
`CORS_ALLOWED_ORIGINS`. Browser mutations require an exact `Origin` match to
`PUBLIC_BASE_URL`; foreign `Origin` and `Sec-Fetch-Site: same-site|cross-site`
requests fail closed. Credential-free GET/EventSource requests may omit
`Origin`.

Public shell and browser API:

- `GET /go` — portal SPA shell; Fastify's global normalization also accepts a
  trailing slash.
- `GET /go/u/{publicId}` — stable per-user shell URL. The reusable secret is supplied only as `#t=...`; the SPA exchanges it and scrubs the fragment.
- `GET /go/api/state` — unauthenticated master-switch state.
- `POST /go/api/auth/exchange` — exchange `{public_id, token}` for the Secure, HttpOnly, SameSite=Strict portal cookie.
- `POST /go/api/logout` — revoke the current browser session and clear its cookie.
- `GET /go/api/me` — current portal identity.
- `GET /go/api/agents` — active and retained eligible agents for the chat list. `presence` is the liveness signal (`listening` accepts instructions, `idle` is alive but has no open relay, `offline` has not heartbeat within 45s, `ended` is read-only); `status` is retained for compatibility only and reads `active` for the life of the wrapper process, so it must not be used for liveness. `attention` is derived from event cursors with no stored read state — a notice stays outstanding until the same session receives a `user_message` (a plain message or a prompt answer) or a `close_requested`. `close` reports the operator close lifecycle (`pending`, `acknowledged`, `undeliverable`) read from the close note's own queue row.
- `GET /go/api/agents/{id}/events[?after=&limit=&tail=1]` — encrypted-at-rest safe timeline, returned in cursor order; `tail=1` returns the latest bounded page.
- `GET /go/api/events[?after=]` — authenticated SSE stream with resumable event IDs and heartbeats. Cookie/global/user authorization is rechecked transactionally for every page; a slow client is closed and resumes from `Last-Event-ID` instead of accumulating an unbounded buffer.
- `POST /go/api/agents/{id}/messages` — enqueue ordinary user text with a client idempotency UUID; returns 202. New work requires a fresh live relay, while an exact retry returns the committed row even if the session finished. Reusing an ID for another user/kind/prompt/body conflicts. A portal message never grants approvals or new authority.
- `POST /go/api/agents/{id}/prompts/{promptId}/answer` — enqueue an answer under a locked first-answer-wins transaction; later answers conflict. Only one open prompt is retained per agent session.
- `POST /go/api/agents/{id}/close` — ask the agent to wind down, delivering the operator's note through the instruction queue as a `close`-kind message so it can finish cleanly; returns 202. Requires a live relay, because an undeliverable note would leave the operator believing the channel is closing. The note is capped at 1000 bytes and is idempotent on `client_message_id`. Sets `close_requested_at`, which is never cleared.
- `POST /go/api/agents/{id}/close/force` — end the session outright; returns 200. Asserts neither liveness nor relay readiness, so it works against an agent that is offline or has already closed its relay. Records the note without delivering it, cancels everything pending, and is a no-op on a session that already ended.

Host and scoped bridge API:

- `GET /host/agent-portal/state` — host-authenticated master-switch probe.
- `POST /host/agent-sessions` — host-authenticated registration for an eligible interactive or human-started execute session. The wrapper retains the short-lived bridge bearer and gives the engine only a private Unix-socket path/session ID; inherited portal variables are scrubbed.
- `POST /host/agent-sessions/{id}/heartbeat` — scoped-bearer heartbeat/rolling expiry renewal. `relay_action=poll` opens/touches the instruction relay and `relay_action=close``relay_action=close` closes it and cancels undelivered session work, except a `close`-kind note the agent has already leased: `cxx portal leave` is how an agent acts on a close, so its own leave must not cancel the instruction it is obeying.
- `POST /host/agent-sessions/{id}/events` — scoped-bearer idempotent safe event publish. The server forces `source=engine` and accepts only assistant/progress/waiting/terminal-block/attention types; answerable waits require a stable prompt UUID.
- `POST /host/agent-sessions/{id}/finish` — idempotent, atomic completed/failed event + terminal transition + pending-work cancellation; makes the session read-only.
- `POST /host/agent-sessions/{id}/commands/claim` — strict FIFO long poll with `{wait_seconds?: 0..25, claim_id: UUID}` and a retryable 30-second lease; repeating the same `claim_id` while its lease is live returns the same item without incrementing attempts. Older leases/backoff always block newer work.
- `POST /host/agent-commands/{messageId}/ack` — explicit acceptance/retry acknowledgement. `cxx portal wait` does not acknowledge: the model issues `portal accept` only after it has received the structured instruction, so an unaccepted lease is redelivered. Accepted state and the visible `message_accepted` event commit in one transaction.

Admin API:

All mutations below require an `owner` or `admin` role; authenticated viewers
may read state and users but cannot change rollout or identity state.

- `GET /admin/agent-portal/state` — switch, configuration, queue health, and dead-letter counts.
- `POST /admin/agent-portal/state` — toggle the global switch. Turning it off revokes browser sessions and cancels queued/leased portal work without replay.
- `GET /admin/agent-portal/users` — list active portal identities and link metadata.
- `POST /admin/agent-portal/users` — create a user with `display_name` and optional `enabled` (default true); returns the permanent magic URL.
- `POST /admin/agent-portal/users/{id}` — update the display name.
- `POST /admin/agent-portal/users/{id}/enabled` — per-user switch; disabling revokes sessions and cancels that user's undelivered work.
- `POST /admin/agent-portal/users/{id}/rotate` — explicitly replace the reusable secret, revoke browser sessions, and return the new URL.
- `GET /admin/agent-portal/users/{id}/link` — re-render the stored permanent link without rotating it, so an operator can bookmark it on another device. Owner/admin only, and audited as `agent_portal.user.link_revealed`; the link is bearer material and is deliberately absent from the `GET /admin/agent-portal/users` listing, which every authenticated admin may read.
- `DELETE /admin/agent-portal/users/{id}` — soft-delete the user, revoke sessions, and cancel pending work.
