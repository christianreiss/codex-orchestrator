# Config Builder

Server-owned `config.toml` with per-host baking, delivered by `cdx`. This doc is for admins/operators wiring Codex defaults across hosts.

## Surfaces

- Console: the direct `/admin/engines` workspace owns the supported Codex
  model, reasoning-effort, version, quota, and scaling controls. There is no
  generic Settings, Config, or Profiles tab in the SPA; keeping those broad
  controls out of the task-oriented console prevents a second editable owner
  for model defaults.
- API: `/admin/config` (GET metadata + `content` + `settings`),
  `/admin/config/render` (preview without saving), `/admin/config/store`
  (persist normalized `settings`), and `/config/retrieve` (host-facing baked
  download) retain the full advanced `config.toml` contract for managed
  automation and integrations.

## Flow

1. A trusted admin integration reads the advanced document from
   `/admin/config`, previews a structured `settings` payload through
   `/admin/config/render`, and stores it through `/admin/config/store`.
2. Server normalizes and renders TOML, stores both the rendered file and the normalized `settings`, and returns `sha256` + size.
3. Hosts call `/config/retrieve` with their API key. The server:
   - Applies any per-host `model_override` + `reasoning_effort_override` to the effective settings.
   - Injects managed HTTP MCP auth for the host: the host API key on secure hosts, or a short-lived MCP bearer on insecure hosts (when orchestrator MCP is enabled).
   - When that managed Codex MCP entry is successfully injected, appends a `[[skills.config]]` entry with `name = "skill-creator"` and `enabled = false` so the built-in local creator cannot bypass authoritative fleet Skill discovery. MCP-disabled or unavailable renders do not suppress it.
   - Appends a trusted projects stanza when `username`/`home` identify a valid home path.
   - Returns baked `sha256` plus `base_sha256` (the stored template hash). When hashes match, `status:unchanged` omits the body.
   - Returns `status:missing` when no config is stored; clients should delete the effective `CODEX_HOME/config.toml` (default `~/.codex/config.toml`).
4. `cdx` writes the baked file to effective `CODEX_HOME/config.toml` during the pre-run sync phase and deletes it when `status:missing`. If an active-run lock skips sync (without `--allow-concurrent-sync`), that invocation does not refresh config.

Default notice mappings:
- Builder defaults include `notice.model_migrations` entries for retired models (`gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.3-codex`) to `gpt-5.6-terra` so Codex upgrade prompts can be auto-resolved from fleet-managed config.
- New top-level config drafts default to `gpt-5.6-terra` with its native `medium` reasoning effort.

## Managed MCP entry

- Native HTTP MCP transport; no node bridge.
- Controlled by `orchestrator_mcp_enabled` in the builder (enabled by default).
- For each host, the server injects a managed entry ahead of any supplied MCP
  servers and filters out reserved orchestrator aliases (`codex-memory`,
  `codex-orchestrator`, `cdx`, `codex-coordinator`) from the persisted list.
- A usable managed Codex entry also owns the `skill-creator` disable rule described above. It is host-baked policy, not part of the stored operator template, and does not apply to Claude.
- Keys are injected at bake time only; the server never stores host API keys inside the template. The exact TOML shape is derived from the internal settings and may change; treat it as implementation-defined rather than a user-editable block.

## Feature switches

The config builder exposes current Codex feature flags under **Security & Features**. These map to `[features]` in rendered `config.toml`:

- `fast_mode` — prefer lower-latency fast mode (enabled by default).
- `unified_exec` — use the unified PTY-backed exec tool.
- `voice_transcription` — enable voice-to-text input tooling for supported clients.
- `apps` — enable connected ChatGPT Apps, including `$` App invocations after `/apps` install + restart (enabled by default).
- `memories` — enable native Codex Memories (`[features].memories = true`) so eligible threads can contribute local memory and later sessions can read it (enabled by default; hosts need Codex `0.125.0+`).
- `guardian_approval` — dispatch `on-request` approval prompts such as sandbox escapes or blocked network access to a carefully-prompted security reviewer subagent instead of blocking on direct user input (disabled by default).
- `js_repl` — enable the persistent Node-backed JavaScript REPL for inline website debugging and JavaScript execution (disabled by default; requires Node `>= v22.22.0` on the host).
- `tui_app_server` — use the app-server-backed TUI implementation (disabled by default).
- `prevent_idle_sleep` — keep the computer awake while Codex is running a thread (disabled by default).
- `multi_agent` — allow Codex to spawn multiple agents in parallel (enabled by default).
- Additional feature flags may be supplied in the API `features` object. The
  normalizer is a denylist, not an allowlist: every key that is not dropped
  below survives into normalized `features` and is rendered under `[features]`,
  so a typo reaches the host verbatim.
- Feature values are coerced to booleans (`true`/`1`/`"yes"`/`"on"` and their negatives). A value that is not boolean-ish normalizes to `null` and that key is then omitted from the rendered `[features]` block.

Legacy compatibility:
- Dropped feature keys: `steer`, `collaboration_modes`, `elevated_windows_sandbox`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`, `remote_models`, `request_permissions`, `request_rule`, `responses_websockets`, `responses_websockets_v2`, `search_tool`, `sqlite`, `use_linux_sandbox_bwrap`, `web_search_cached`, `web_search_request`.
- Those keys are accepted for ingest compatibility but removed from normalized/rendered output — they are discarded, not migrated onto any other field. `features.web_search` is dropped the same way; root `web_search` is the only source for the web search toggle.

## Security toggles

The builder also supports a small set of `cdx` wrapper toggles under a `[security]` block.

- `dangerously_bypass_approvals_and_sandbox` — when `true`, `cdx` adds `--dangerously-bypass-approvals-and-sandbox` to the Codex CLI invocation. This disables safety guardrails; keep it off by default.

## Approval policy values

`approval_policy` is rendered at the root of `config.toml`.

- Accepted values: `untrusted`, `on-request`, `on-failure`, `never`.
- Input is lowercased and otherwise kept verbatim — `on-failure` is stored and rendered as `on-failure`, not rewritten to `on-request`. Upstream Codex marks it deprecated, so prefer `on-request` for new configs.
- Any other value normalizes to `null` and the `approval_policy` line is omitted from the rendered config, leaving the host on its own default.

## Web search toggle

`web_search` is a boolean and is rendered at the root of `config.toml` (not under `[features]`).

- Accepted values: `true`, `false`.
- Boolean-ish inputs are coerced: `1`/`0`, `"true"`/`"false"`, `"yes"`/`"no"`, `"on"`/`"off"`.
- Anything else — including an absent key and the legacy `live`/`cached`/`disabled` strings — normalizes to `null`, and the root `web_search` line is then omitted from the rendered config.
- `features.web_search`, `features.web_search_request` and `features.web_search_cached` are dropped on normalize; they do not set the root field. Configs still carrying them must set root `web_search` explicitly.

## OTEL wiring

The builder can also emit an `[otel]` block. The wrapper (`cdx`) reads this and exports `OTEL_*` environment variables when launching the Codex CLI, so your existing collector can ingest traces without per-host shell glue.

Example:
```toml
[otel]
environment = "prod"
exporter = { "otlp-http" = { endpoint = "https://otel.example.com", protocol = "http/protobuf", headers = { "x-otlp-api-key" = "${OTLP_TOKEN}" } } } # or otlp-grpc
log_user_prompt = false
```

Recognized OTEL input keys are `environment`, `exporter`, `endpoint`, `protocol`, `headers`, and `log_user_prompt`. Unknown keys are ignored.

## Failure modes / edge cases

- API key + IP binding enforced (same as `/auth`); roaming hosts need `allow_roaming_ips` toggled if their IP changes.
- Hash short-circuit: if the client sends `sha256` matching the baked file, response is `status:unchanged` with no `content`.
- Missing config: `status:missing` → client must delete local file to avoid stale defaults.
- Origin: `/admin/config*` is behind admin authentication (and deployment
  mTLS when enabled); host fetches use host API key auth and the same host/IP
  policy checks used by `/auth`.

## Quick commands

- Preview without saving:
  ```bash
  curl -s "$BASE/admin/config/render" \
    -H "Content-Type: application/json" \
    -d '{"settings":{"model":"gpt-5.6-terra","model_reasoning_effort":"medium","approval_policy":"on-request"}}' | jq .
  ```
- Fetch baked config for a host:
  ```bash
  curl -s "$BASE/config/retrieve" \
    -H "Authorization: Bearer $HOST_API_KEY" \
    -d '{"sha256":""}' | jq .
  ```

## Model provider controls

The builder can also set:

- `model_provider` — top-level `config.toml` key that maps to `codex --config model_provider=...` (e.g. `openai` or `oss`). Leave blank to inherit client defaults.
- `local_provider` — used alongside `model_provider=oss` to select the local provider (e.g. `lmstudio` or `ollama`).

## When to update

- Whenever you change models/providers, approval policy, sandbox defaults, notices, MCP servers, OTEL, or custom blocks.
- After rotating host API keys if you rely on the managed MCP entry (baked hash will change automatically).

## Communication style

`personality` is rendered at the root of `config.toml` and controls the default Codex communication style exposed by `/personality`.

- Accepted values: `friendly`, `pragmatic`, `none`.
- Input is lowercased; anything outside that set (including a blank or missing value) falls back to `friendly`, so the root key is always rendered.
- Entries in the optional `profiles` API payload may override `personality`;
  leaving the field blank inherits the root value.
- The separate `features.personality` gate remains available through the
  advanced API `features` payload for hosts that need to disable the chooser
  while keeping a root default in place.
