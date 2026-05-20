---
title: Keyboard shortcuts and API reference
section: Integrations and reference
verified: 2026-05-20
sources: api/src/routes/index.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/hosts/index.ts, api/src/routes/admin/settings/index.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/users/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/keys/openai.ts, api/src/routes/admin/keys/claude.ts, api/src/routes/admin/projects/index.ts, api/src/routes/admin/manual/index.ts, api/src/routes/auth/index.ts, api/src/routes/host/index.ts, api/src/routes/cli-auth/index.ts, api/src/routes/install/index.ts, api/src/routes/wrapper-v2/index.ts, api/src/routes/mcp/index.ts
---

Two reference tables, pulled from the code as of this manual's verified date.

## Keyboard shortcuts

Shortcuts are handled by the admin SPA. Modifier combinations (Ctrl/Alt/Cmd) are ignored; shortcuts pause while typing in an editable target.

**Single-key shortcuts**

| Key | Action |
|-----|--------|
| `d` | Jump to `/admin/dashboard` |
| `m` | Jump to `/admin/manual` |
| `n` | New item (host, user, command, skill — contextual) |
| `r` | Refresh the current view |
| `t` | Toggle the visible drawer/panel |
| `/` | Focus the active search box (or host search on dashboard) |
| `?` | Show the keyboard-shortcuts help modal |
| `Esc` | Close open modal / dismiss |

**Prefixed shortcuts** (press the first letter, then the second)

| Chord | Action |
|-------|--------|
| `h a` | Hosts — all |
| `h s` | Hosts — secure |
| `h i` | Hosts — insecure |
| `h n` | New host |
| `l c` | Logs — API |
| `l m` | Logs — MCP |
| `l e` | Logs — events |
| `s g` | Settings — general |
| `s u` | Settings — users |
| `s a` | Settings — agents |
| `s c` | Settings — OpenAI config |
| `s l` | Settings — Claude |
| `s i` | Settings — API keys |
| `s k` | Settings — skills |
| `s m` | Settings — memories |
| `s p` | Settings — projects |
| `s r` | Settings — profiles |

Pressing the prefix key a second time in a row (e.g. `h h`) toggles the matching rail group open/closed instead of navigating.

## Admin HTTP routes

Mounted by `api/src/routes/index.ts`. Method + path + the source file. All `/admin/*` JSON endpoints require an authenticated admin session (`app.requireAdmin`) unless explicitly noted.

### Admin auth + passkeys

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/auth/status` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/login` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/login/method` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/logout` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/password/change` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/password/request` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/password/reset` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/login/options` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/login` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/register/options` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/register` | api/src/routes/admin/auth/index.ts |
| GET | `/admin/passkeys` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/passkeys/:id/name` | api/src/routes/admin/auth/index.ts |
| DELETE | `/admin/passkeys/:id` | api/src/routes/admin/auth/index.ts |

### Admin users

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/users` | api/src/routes/admin/users/index.ts |
| POST | `/admin/users` | api/src/routes/admin/users/index.ts |
| POST | `/admin/users/:id` | api/src/routes/admin/users/index.ts |
| DELETE | `/admin/users/:id` | api/src/routes/admin/users/index.ts |
| POST | `/admin/users/wipe` | api/src/routes/admin/users/index.ts |

### Admin hosts

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/hosts` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/hosts/insecure` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/hosts/register` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/quick-register` | api/src/routes/admin/hosts/index.ts |
| GET | `/admin/hosts/:id/detail` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/hosts/:id/auth` | api/src/routes/admin/hosts/index.ts |
| GET | `/admin/hosts/:id/installer` | api/src/routes/admin/hosts/index.ts |
| DELETE | `/admin/hosts/:id` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/clear` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/roaming` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/secure` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/vip` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/scaling-exempt` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/auto-update` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/insecure/enable` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/insecure/disable` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/curl-insecure` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/browseros-mcp` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/reverse-dns` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/model` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/codex-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/claude-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/agents-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/insecure/extend` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/hosts/insecure/disable-all` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/insecure-approvals/pending` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/allow-domain` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/approve` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/deny` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-domain-allows/:id/revoke` | api/src/routes/admin/hosts/index.ts |

### Admin settings

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/api/state` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/cdx-silent` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/theme` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/reverse-dns` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/auto-update` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/insecure-approval` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/quota-mode` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/prune-policy` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/log-retention` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/scaling` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/openai/state` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/claude/state` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/claude/settings` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/claude/version` | api/src/routes/admin/settings/index.ts |
| GET | `/admin/claude/usage/history` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/codex-version` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/versions/check` | api/src/routes/admin/settings/index.ts |

### Admin overview / dashboard

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/overview` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/ws/info` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/toasts` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/tokens` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/usage` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/usage/ingests` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/chatgpt/usage` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/chatgpt/usage/history` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/chatgpt/usage/refresh` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/runner` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/runner/run` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/runner/run-claude` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/auth/seed-command` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/auth/upload` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/logs` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/mcp/logs` | api/src/routes/admin/config/index.ts |

### Admin config / agents / skills / memories

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/config` | api/src/routes/admin/config/index.ts |
| POST | `/admin/config/render` | api/src/routes/admin/config/index.ts |
| POST | `/admin/config/store` | api/src/routes/admin/config/index.ts |
| GET | `/admin/agents` | api/src/routes/admin/config/index.ts |
| GET | `/admin/agents/versions/:id` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/store` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/serve` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/revert` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/retention` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/agents/versions/:id` | api/src/routes/admin/config/index.ts |
| GET | `/admin/mcp/memories` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/mcp/memories/:id` | api/src/routes/admin/config/index.ts |
| GET | `/admin/skills` | api/src/routes/admin/config/index.ts |
| GET | `/admin/skills/:slug` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/generate` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/assist` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/store` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/skills/:slug` | api/src/routes/admin/config/index.ts |

### Admin API keys

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/openai/keys` | api/src/routes/admin/keys/openai.ts |
| POST | `/admin/openai/keys/:id/toggle` | api/src/routes/admin/keys/openai.ts |
| DELETE | `/admin/openai/keys/:id` | api/src/routes/admin/keys/openai.ts |
| GET/POST | `/admin/claude/keys` | api/src/routes/admin/keys/claude.ts |
| POST | `/admin/claude/keys/:id/toggle` | api/src/routes/admin/keys/claude.ts |
| DELETE | `/admin/claude/keys/:id` | api/src/routes/admin/keys/claude.ts |

### Admin projects

Every project endpoint lives in `api/src/routes/admin/projects/index.ts` and mirrors the host-facing `/projects/*` surface in `api/src/routes/projects-client/index.ts`. See [projects](/admin/manual/projects) for the full shape.

### Admin manual

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/manual/manifest` | api/src/routes/admin/manual/index.ts |
| GET | `/admin/manual/search` | api/src/routes/admin/manual/index.ts |
| GET | `/admin/manual/article/:slug` | api/src/routes/admin/manual/index.ts |

### Admin websocket

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/ws` (websocket upgrade) | api/src/ws/server.ts |

### Host-facing and public routes

| Method | Route | Source |
|--------|-------|--------|
| POST | `/auth` | api/src/routes/auth/index.ts |
| POST | `/sync/status` | api/src/routes/auth/index.ts |
| POST | `/sync/bootstrap` | api/src/routes/auth/index.ts |
| DELETE | `/auth` | api/src/routes/auth/index.ts |
| GET | `/versions` | api/src/routes/host/index.ts |
| POST | `/host/users` | api/src/routes/host/index.ts |
| GET/POST | `/host/lane` | api/src/routes/host/index.ts |
| POST | `/usage` | api/src/routes/host/index.ts |
| POST | `/cron/check` | api/src/routes/host/index.ts |
| POST | `/cron/report` | api/src/routes/host/index.ts |
| GET | `/wrapper` (alias of `/wrapper/v2/meta`) | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/download` (alias of `/wrapper/v2/download`) | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/meta` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/config[?sig=1]` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/download` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/manifest/:engine` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/bin/:engine/:plat/v:version/:binary` | api/src/routes/wrapper-v2/index.ts |
| GET | `/install/:token` (alias of `/install/v2/:token`) | api/src/routes/install/index.ts |
| GET | `/install/v2/:token` | api/src/routes/install/index.ts |
| GET | `/seed/auth/:token` (alias of `/seed/v2/auth/:token`) | api/src/routes/install/index.ts |
| POST | `/seed/auth/:token` | api/src/routes/install/index.ts |
| GET/POST | `/seed/v2/auth/:token` | api/src/routes/install/index.ts |
| POST | `/cli/auth/start` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/poll/:id` | api/src/routes/cli-auth/index.ts |
| GET | `/cli/auth/verify` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/lookup` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/approve` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/deny` | api/src/routes/cli-auth/index.ts |
| GET/POST | `/mcp` | api/src/routes/mcp/index.ts |

### OpenAI- and Anthropic-compatible APIs

Under `/v1/*` — `api/src/routes/openai-compat/` — and `/anthropic/v1/*` — `api/src/routes/anthropic-compat/`. Each supports `chat/completions`, `responses`, `completions`, `embeddings`, `models`, plus CORS `OPTIONS`. Authentication is by `sk-coco-…` API key; requests proxy through the shared runner with quota accounting.

## Source references

- api/src/routes/index.ts (route mounting)
- api/src/routes/admin/**/*.ts (every admin route)
- api/src/routes/auth/index.ts, host/index.ts, cli-auth/index.ts (host-facing surface)
- api/src/routes/wrapper-v2/index.ts, install/index.ts (wrapper + install endpoints)
- api/src/routes/mcp/index.ts (MCP JSON-RPC)
- api/src/ws/server.ts (admin websocket)
