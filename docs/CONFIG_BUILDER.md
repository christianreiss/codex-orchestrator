# Config Builder

Server-owned `config.toml` with per-host baking, delivered by `cdx`. This doc is for admins/operators wiring Codex defaults across hosts.

## Surfaces

- Web UI: `/admin/` (Config tab in the admin SPA served for `/admin/*`) — full-form builder for fleet `config.toml` (model defaults, personality, approval policy, sandbox, notices, MCP servers, OTEL, env policy, custom blocks). Profile management lives under **Settings → Profiles**.
- API: `/admin/config` (GET metadata + `content` + `settings`), `/admin/config/render` (preview without saving, rendered for a placeholder host API key), `/admin/config/store` (persist from normalized `settings`), `/config/retrieve` (host-facing baked download).

## Flow

1. Admin edits the Config tab under `/admin/`. The UI can preview via `/admin/config/render` and POSTs structured `settings` to `/admin/config/store`.
2. Server normalizes and renders TOML, stores both the rendered file and the normalized `settings`, and returns `sha256` + size.
3. Hosts call `/config/retrieve` with their API key. The server:
   - Applies any per-host `model_override` + `reasoning_effort_override` to the effective settings.
   - Injects managed HTTP MCP auth for the host: the host API key on secure hosts, or a short-lived MCP bearer on insecure hosts (when orchestrator MCP is enabled).
   - Appends a trusted projects stanza when `username`/`home` identify a valid home path.
   - Returns baked `sha256` plus `base_sha256` (the stored template hash). When hashes match, `status:unchanged` omits the body.
   - Returns `status:missing` when no config is stored; clients should delete `~/.codex/config.toml`.
4. `cdx` writes the baked file to `~/.codex/config.toml` during the pre-run sync phase and deletes it when `status:missing`. If an active-run lock skips sync (without `--allow-concurrent-sync`), that invocation does not refresh config.

Default notice mappings:
- Builder defaults include `notice.model_migrations` entries for `gpt-5.2-codex -> gpt-5.3-codex` and `gpt-5.3-codex -> gpt-5.4` so Codex upgrade prompts can be auto-resolved from fleet-managed config.

## Managed MCP entry

- Native HTTP MCP transport; no node shim.
- Controlled by `orchestrator_mcp_enabled` in the builder (enabled by default).
- For each host, the server injects a managed entry ahead of any user-configured MCP servers and filters out reserved orchestrator aliases (`codex-memory`, `codex-orchestrator`, `cdx`, `codex-coordinator`) from the UI-configurable list.
- Keys are injected at bake time only; the server never stores host API keys inside the template. The exact TOML shape is derived from the internal settings and may change; treat it as implementation-defined rather than a user-editable block.

## Feature switches

The config builder exposes current Codex feature flags under **Security & Features**. These map to `[features]` in rendered `config.toml`:

- `fast_mode` — prefer lower-latency fast mode (enabled by default).
- `unified_exec` — use the unified PTY-backed exec tool.
- `voice_transcription` — enable voice-to-text input tooling for supported clients.
- `apps` — enable connected ChatGPT Apps, including `$` App invocations after `/apps` install + restart (enabled by default).
- `guardian_approval` — dispatch `on-request` approval prompts such as sandbox escapes or blocked network access to a carefully-prompted security reviewer subagent instead of blocking on direct user input (disabled by default).
- `js_repl` — enable the persistent Node-backed JavaScript REPL for inline website debugging and JavaScript execution (disabled by default; requires Node `>= v22.22.0` on the host).
- `use_linux_sandbox_bwrap` — try the new Linux sandbox based on bubblewrap (disabled by default).
- `prevent_idle_sleep` — keep the computer awake while Codex is running a thread (disabled by default).
- `multi_agent` — allow Codex to spawn multiple agents in parallel (enabled by default).
- Additional feature flags may be passed through from the UI `extraFeatures` textarea, but only currently supported Codex feature flags are kept in normalized/rendered output.

Legacy compatibility:
- `features.web_search_request` and `features.web_search_cached` are normalized into root `web_search`.
- Removed feature keys (`steer`, `collaboration_modes`, `elevated_windows_sandbox`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`, `remote_models`, `request_rule`, `search_tool`) are accepted for ingest compatibility but dropped from normalized/rendered output.

## Security toggles

The builder also supports a small set of `cdx` wrapper toggles under a `[security]` block.

- `dangerously_bypass_approvals_and_sandbox` — when `true`, `cdx` adds `--dangerously-bypass-approvals-and-sandbox` to the Codex CLI invocation. This disables safety guardrails; keep it off by default.

## Approval policy values

`approval_policy` should use `untrusted`, `on-request`, or `never`.

- Legacy `on-failure` inputs are accepted for backward compatibility but normalized to `on-request` on render/store.
- The admin UI intentionally omits `on-failure` because upstream Codex marks it deprecated.

## Web search toggle

`web_search` controls web search tool calls and is rendered at the root of `config.toml` (not under `[features]`): `live`, `cached`, or `disabled`. Legacy configs using `features.web_search_request` or `features.web_search` are normalized to the root field on save.

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
- Origin: `/admin/` is behind admin auth/mTLS; host fetches use host API key auth and the same host/IP policy checks used by `/auth`.

## Quick commands

- Preview without saving:
  ```bash
  curl -s "$BASE/admin/config/render" \
    -H "Content-Type: application/json" \
    -d '{"settings":{"model":"gpt-5.3-codex","approval_policy":"on-request"}}' | jq .
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

- Allowed values: `friendly`, `pragmatic`, `none`.
- The builder defaults to `friendly`.
- Profiles may optionally override `personality`; leaving the profile field blank inherits the root value.
- The separate `features.personality` gate remains available through the advanced feature textarea for hosts that need to disable the chooser while keeping a root default in place.
