# Config Builder

Server-owned `config.toml` with per-host baking, delivered by `cdx`. This doc is for admins/operators wiring Codex defaults across hosts.

## Surfaces

- Web UI: `/admin/config.html` — full-form builder (models/providers/profiles, approval policy, sandbox, notices, MCP servers, OTEL, env policy, custom blocks).
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
