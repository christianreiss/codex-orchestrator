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
- Builder defaults include `notice.model_migrations` entries for retired models (`gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`) to `gpt-6-astra` so Codex upgrade prompts can be auto-resolved from fleet-managed config. This is the intended state, not necessarily the stored one — `notice.model_migrations` is operator-entered template data, not code-derived, so it drifts silently when the default model changes and nobody revisits it. **Found drifted 2026-08-08**: the live template mapped 3 of the then-retired IDs to `gpt-5.4` instead of the then-current default, was missing `gpt-5.2` and `gpt-5.3-codex`, and additionally carried a wrong `gpt-5.3-codex-spark` → `gpt-5.4` entry. Fix stored template drift with a one-off admin-API write; there is no code-level template default to repair.
- New top-level config drafts default to `gpt-6-astra` with its native `medium` reasoning effort.

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
- `apps` — enable connected ChatGPT Apps, including `$` App invocations after `/apps` install + restart. **Disabled by default** — both upstream Codex's own default and the fleet template agree on `false`; this entry previously (incorrectly) said "enabled by default", corrected 2026-08-08.
- `memories` — enable native Codex Memories (`[features].memories = true`) so eligible threads can contribute local memory and later sessions can read it (enabled by default; hosts need Codex `0.125.0+`).
- `guardian_approval` — dispatch `on-request` approval prompts such as sandbox escapes or blocked network access to a carefully-prompted security reviewer subagent instead of blocking on direct user input (disabled by default).
- `prevent_idle_sleep` — keep the computer awake while Codex is running a thread (disabled by default; still `experimental` stage upstream as of codex-cli 0.147.0).
- `multi_agent` — allow Codex to spawn multiple agents in parallel (enabled by default).
- `code_mode_host` — spawns a companion `codex-code-mode-host` process to back Code Mode execution. Upstream ships this **stable and enabled by default**. **Do not disable this in the template as a fix** — verified 2026-08-08 that disabling it does not even suppress the warning (`claude`/`codex` still prints "Code Mode is unavailable because code-mode host is disabled"; only an absent/true key with the binary actually present produces clean output). The real gap is that the fleet's own wrapper distribution has never published the companion binary to any host's `/usr/local/bin` (confirmed absent from the wrapper store, 2026-08-08) — but it is a real, version-pinned artifact OpenAI publishes on every `openai/codex` GitHub release (e.g. `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` on tag `rust-v0.147.0`, matching `codex-cli` 0.147.0 exactly; the CLI and host binary share a versioned handshake, so they must be pinned together). Manually installed and proven clean (real `cdx --execute` round trip, zero warning) on 2 hosts on 2026-08-08. Fleet-wide fix is to teach the wrapper's install/update path to fetch and place this binary alongside `codex` itself, the same way it already tracks the `codex` version — not yet built.
- Additional feature flags may be supplied in the API `features` object. The
  normalizer is a denylist, not an allowlist: every key that is not dropped
  below survives into normalized `features` and is rendered under `[features]`,
  so a typo reaches the host verbatim.
- Feature values are coerced to booleans (`true`/`1`/`"yes"`/`"on"` and their negatives). A value that is not boolean-ish normalizes to `null` and that key is then omitted from the rendered `[features]` block.

Legacy compatibility:
- Dropped feature keys: `steer`, `collaboration_modes`, `elevated_windows_sandbox`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`, `remote_models`, `request_permissions`, `request_rule`, `responses_websockets`, `responses_websockets_v2`, `search_tool`, `sqlite`, `use_linux_sandbox_bwrap`, `web_search_cached`, `web_search_request`, `js_repl`, `tui_app_server`, `voice_transcription`.
- Those keys are accepted for ingest compatibility but removed from normalized/rendered output — they are discarded, not migrated onto any other field. `features.web_search` is dropped the same way; root `web_search` is the only source for the web search toggle.
- `js_repl`, `tui_app_server`, `voice_transcription` moved here 2026-08-08: verified against `codex features list` on codex-cli 0.147.0 that `js_repl` and `tui_app_server` are stage `removed` (the latter permanently folded into stable behavior, default `true`, not optional) and `voice_transcription` no longer appears in the feature registry at all. All three were still being documented as live toggles and rendered into every host's `[features]` block; they now normalize away like the rest of this list.

## Security toggles

The builder still accepts a `[security]` block, but be aware of what it does — which, today, is nothing.

- `dangerously_bypass_approvals_and_sandbox` — **inert.** The server renders this key into
  `config.toml`, but no Go code parses a `[security]` block; the sentence that used to appear here
  ("`cdx` adds `--dangerously-bypass-approvals-and-sandbox`") described the retired *bash* `cdx`,
  which had its own TOML parser. The current wrapper reads
  `engine_options.dangerously_bypass_approvals_and_sandbox` from the **signed** config
  (`wrappers/cxx/internal/codex/lane.go`), and `wrapper-config.ts`'s `engineOptions()` never emits
  that key. So the server writes a key nobody reads and the wrapper reads a key nobody writes.
- Do **not** "fix" this by baking `engine_options`. That would arm the bypass on every host whose
  `[security]` key is already `true`, over a revoke channel measured in days: the signed config has
  a 30-day TTL and is refreshed only by the daily managed cron, never on the launch path.
- The working equivalent is the pair `approval_policy = "never"` + `sandbox_mode =
  "danger-full-access"`, both of which are real Codex keys on the fast path and revoke within one
  launch.

## Security posture overlay

Fleet security levels are applied as a **per-host bake-time overlay**, layered over the stored
template immediately after the model/effort host overrides and before normalization. Nothing is
written back into the stored document, so the operator template remains the single editable owner.

For the keys posture claims — `approval_policy`, `sandbox_mode`,
`sandbox_workspace_write.network_access`, `web_search`, `features.guardian_approval`, and Claude's
`permissions.defaultMode` — the posture value **wins over** the same key in the template, exactly
as a host model override already does. `sandbox_workspace_write` is merged rather than replaced, so
operator `writable_roots` and exclusions survive. Everything else in the template is untouched.

One posture value is not served verbatim. **A host whose agent user is root is never sent
`permissions.defaultMode: bypassPermissions`**, because Claude Code refuses to start in that mode
under root or sudo and has no supported override for it. Serving the operator's selection there
would yield an agent that cannot launch rather than a permissive one, and the failure is silent on
the relay path — a peer dies before reporting and its delivery goes terminally `ambiguous`. The
bake substitutes `auto`, upstream's own recommended replacement for a bypass, and reports the
substitution so `clx doctor` and the posture console can name it. Every other posture value, and
every non-root host, is unaffected. The posture mapping itself is unchanged: `securityLevelEnforcement`
still reports that the vector asks for `bypassPermissions`, because this is a delivery constraint
and not a change to what the operator selected.

`sandbox_mode` accepts `read-only`, `workspace-write`, or `danger-full-access`. It is validated on
write only; values already stored normalize with a warning rather than throwing, so one bad row
cannot take the fleet down.

## Approval policy values

`approval_policy` is rendered at the root of `config.toml`.

- Accepted values: `untrusted`, `on-request`, `on-failure`, `never`.
- Input is lowercased and otherwise kept verbatim — `on-failure` is stored and rendered as `on-failure`, not rewritten to `on-request`. Upstream Codex marks it deprecated, so prefer `on-request` for new configs.
- Any other value normalizes to `null` and the `approval_policy` line is omitted from the rendered config, leaving the host on its own default.

## Web search toggle

`web_search` is a string enum and is rendered at the root of `config.toml` (not under `[features]`).

- Accepted values: `disabled`, `cached`, `indexed`, `live`.
- This is Codex's own enum, verified against codex-cli 0.146.0. A **boolean makes
  Codex reject the entire `config.toml`** (`invalid type: unit variant, expected
  string only in web_search`), not just this key — so the builder must never emit one.
- Legacy boolean-ish inputs are migrated rather than dropped, because stored
  documents still hold them: `true`/`1`/`"yes"`/`"on"` become `live`, and
  `false`/`0`/`"no"`/`"off"` become `disabled`.
- Anything else, including an absent key, normalizes to `null`, and the root `web_search` line is then omitted from the rendered config.
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
  the admin session); host fetches use host API key auth and the same host/IP
  policy checks used by `/auth`.

## Quick commands

- Preview without saving:
  ```bash
  curl -s "$BASE/admin/config/render" \
    -H "Content-Type: application/json" \
    -d '{"settings":{"model":"gpt-6-astra","model_reasoning_effort":"medium","approval_policy":"on-request"}}' | jq .
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
