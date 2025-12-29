# Config Builder

Server-owned `config.toml` with per-host baking, delivered by `cdx`. This doc is for admins/operators wiring Codex defaults across hosts.

## Surfaces

- Web UI: `/admin/config.html` — full-form builder for fleet `config.toml` (model defaults, approval policy, sandbox, notices, MCP servers, OTEL, env policy, custom blocks). Profile management lives under **Settings → Profiles**.
- API: `/admin/config` (GET metadata), `/admin/config/render` (preview without saving), `/admin/config/store` (persist), `/config/retrieve` (host-facing baked download).

## Flow

1. Admin edits `/admin/config.html`. The UI POSTs structured `settings` to `/admin/config/store`.
2. Server normalizes and renders TOML, stores both the rendered file and the normalized `settings`, and returns `sha256` + size.
3. Hosts call `/config/retrieve` with their API key. The server:
   - Injects that host’s API key into the managed MCP entry (if enabled).
   - Returns baked `sha256` plus `base_sha256` (the stored template hash). When hashes match, `status:unchanged` omits the body.
   - Returns `status:missing` when no config is stored; clients should delete `~/.codex/config.toml`.
4. `cdx` writes the baked file to `~/.codex/config.toml` on every run and deletes it when `status:missing`.

## Managed MCP entry

- Native HTTP; no node shim.
- Rendered automatically unless you disable it in the builder:
  ```toml
  [mcp_servers.cdx]
  url = "{base_url}/mcp"
  http_headers = { Authorization = "Bearer {host_api_key}" }
  ```
- Keys are injected at bake time only; the server never stores host API keys inside the template.

## Experimental feature switches

The config builder exposes the currently supported experimental feature flags under **Security & Features**. These map to `[features]` in the rendered `config.toml`:

- `streamable_shell` — stream shell output live.
- `background_terminal` — run long-running terminal commands in the background.
- `unified_exec` — use the unified PTY-backed exec tool.
- `rmcp_client` — enable OAuth for streamable HTTP MCP servers.
- `experimental_sandbox_command_assessment` — model-based sandbox risk assessment.
- `ghost_commit` — create a ghost commit on each turn.
- `enable_experimental_windows_sandbox` — use the Windows restricted-token sandbox when supported.

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
    -d '{"settings":{"model":"gpt-5.1-codex","approval_policy":"trusted"}}' | jq .
  ```
- Fetch baked config for a host:
  ```bash
  curl -s "$BASE/config/retrieve" \
    -H "Authorization: Bearer $HOST_API_KEY" \
    -d '{"sha256":""}' | jq .
  ```

## When to update

- Whenever you change models/providers, approval policy, sandbox defaults, notices, MCP servers, OTEL, or custom blocks.
- After rotating host API keys if you rely on the managed MCP entry (baked hash will change automatically).
