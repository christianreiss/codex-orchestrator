# Config Builder

Server-owned `config.toml` with per-host baking, delivered by `cdx`. This doc is for admins/operators wiring Codex defaults across hosts.

## Surfaces

- Web UI: `/admin/config.html` — full-form builder for fleet `config.toml` (model defaults, approval policy, sandbox, notices, MCP servers, OTEL, env policy, custom blocks). Profile management lives under **Settings → Profiles**.
- API: `/admin/config` (GET metadata + `content` + `settings`), `/admin/config/render` (preview without saving, rendered for a placeholder host API key), `/admin/config/store` (persist from normalized `settings`), `/config/retrieve` (host-facing baked download).

## Flow

1. Admin edits `/admin/config.html`. The UI POSTs structured `settings` to `/admin/config/store`.
2. Server normalizes and renders TOML, stores both the rendered file and the normalized `settings`, and returns `sha256` + size.
3. Hosts call `/config/retrieve` with their API key. The server:
   - Applies any per-host `model_override` + `reasoning_effort_override` to the effective settings.
   - Injects that host’s API key into the managed HTTP MCP entry (when orchestrator MCP is enabled).
   - Appends a trusted projects stanza when `username`/`home` identify a valid home path.
   - Returns baked `sha256` plus `base_sha256` (the stored template hash). When hashes match, `status:unchanged` omits the body.
   - Returns `status:missing` when no config is stored; clients should delete `~/.codex/config.toml`.
4. `cdx` writes the baked file to `~/.codex/config.toml` on every run and deletes it when `status:missing`.

## Managed MCP entry

- Native HTTP MCP transport; no node shim.
- Controlled by `orchestrator_mcp_enabled` in the builder (enabled by default).
- For each host, the server injects a managed entry ahead of any user-configured MCP servers and filters out reserved coordinator names (`codex-memory`, `codex-orchestrator`, `cdx`, `codex-coordinator`) from the UI-configurable list.
- Keys are injected at bake time only; the server never stores host API keys inside the template. The exact TOML shape is derived from the internal settings and may change; treat it as implementation-defined rather than a user-editable block.

## Experimental feature switches

The config builder exposes the currently supported experimental feature flags under **Security & Features**. These map to `[features]` in the rendered `config.toml`:

- `streamable_shell` — stream shell output live.
- `background_terminal` — run long-running terminal commands in the background.
- `unified_exec` — use the unified PTY-backed exec tool.
- `rmcp_client` — enable OAuth for streamable HTTP MCP servers.
- `view_image_tool` — enable image input tooling for supported clients.
- `experimental_sandbox_command_assessment` — model-based sandbox risk assessment.
- `ghost_commit` — create a ghost commit on each turn.
- `experimental_windows_sandbox` — use the Windows restricted-token sandbox when supported.
- Additional feature flags may be passed through from the UI `extraFeatures` textarea; these are written verbatim under `[features]` when set.

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
exporter = "otlp-http" # or otlp-grpc
  endpoint = "https://otel.example.com"
  protocol = "http/protobuf" # optional; defaults to http/protobuf for otlp-http
  headers = { "x-otlp-api-key" = "${OTLP_TOKEN}" }
  log_user_prompt = false
```

Any additional OTEL keys present in the `settings.otel` map are normalized and emitted as TOML fields; keys not present in code are ignored.

## Failure modes / edge cases

- API key + IP binding enforced (same as `/auth`); roaming hosts need `allow_roaming_ips` toggled if their IP changes.
- Hash short-circuit: if the client sends `sha256` matching the baked file, response is `status:unchanged` with no `content`.
- Missing config: `status:missing` → client must delete local file to avoid stale defaults.
- Origin: `/admin/config.html` is behind admin auth/mTLS; host fetches require only the host API key.

## Quick commands

- Preview without saving:
  ```bash
  curl -s "$BASE/admin/config/render" \
    -H "Content-Type: application/json" \
    -d '{"settings":{"model":"gpt-5.3-codex","approval_policy":"trusted"}}' | jq .
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
