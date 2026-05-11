---
title: Keyboard shortcuts and API reference
section: Integrations and reference
verified: 2026-04-19
sources: public/index.php, public/admin/assets/dashboard.js, public/admin/assets/nav.js, public/admin/index.html, src/Http/Controllers/AdminPageController.php, src/Http/Controllers/AdminManualController.php
---

Two reference tables, pulled from the code as of this manual's verified date.

## Keyboard shortcuts

All shortcuts are handled by `handleGlobalShortcut` in `public/admin/assets/dashboard.js` (line 1418) with prefix arming and disclosure toggling in `nav.js`. Modifier combinations (Ctrl/Alt/Cmd) are ignored; shortcuts pause while typing in an editable target.

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

Registered in `public/index.php`. Method + regex + the PHP callable.

### Admin pages (SPA shell)

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/admin/` | `AdminPageController::index` |
| GET | `/admin/login` | `AdminPageController::login` |
| GET | `/admin/dashboard` | `AdminPageController::dashboard` |
| GET | `/admin/hosts/{id}` | `AdminPageController::host` |
| GET | `/admin/hosts/secure` | `AdminPageController::hostsSecure` |
| GET | `/admin/hosts/unprovisioned` | `AdminPageController::hostsUnprovisioned` |
| GET | `/admin/skills/new` | `AdminPageController::skill` |
| GET | `/admin/account(/password\|passkeys)?` | `AdminPageController::account` |
| GET | `/admin/settings` | `AdminPageController::settings` |
| GET | `/admin/settings/{section}` | `AdminPageController::settingsSection` |
| GET | `/admin/logs/(mcp\|events)` | `AdminPageController::logs` |
| GET | `/admin/manual` | `AdminPageController::manual` |
| GET | `/admin/manual/{slug}` | `AdminPageController::manual` |

### Admin auth

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/admin/auth/status` | `AdminAuthController::status` |
| POST | `/admin/auth/login` | `AdminAuthController::login` |
| POST | `/admin/auth/login/method` | `AdminAuthController::loginMethod` |
| POST | `/admin/auth/logout` | `AdminAuthController::logout` |
| POST | `/admin/auth/password/change` | `AdminAuthController::passwordChange` |
| POST | `/admin/auth/password/request` | `AdminAuthController::passwordRequest` |
| POST | `/admin/auth/password/reset` | `AdminAuthController::passwordReset` |
| POST | `/admin/auth/passkey/login/options` | `AdminAuthController::passkeyLoginOptions` |
| POST | `/admin/auth/passkey/login` | `AdminAuthController::passkeyLogin` |
| POST | `/admin/auth/passkey/register/options` | `AdminAuthController::passkeyRegisterOptions` |
| POST | `/admin/auth/passkey/register` | `AdminAuthController::passkeyRegister` |
| GET | `/admin/passkeys` | `AdminAuthController::passkeyList` |
| POST | `/admin/passkeys/{id}/name` | `AdminAuthController::passkeyRename` |
| DELETE | `/admin/passkeys/{id}` | `AdminAuthController::passkeyDelete` |

### Admin users

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/admin/users` | `AdminUserController::index` (or SPA for browsers) |
| POST | `/admin/users` | `AdminUserController::store` |
| POST | `/admin/users/{id}` | `AdminUserController::update` |
| DELETE | `/admin/users/{id}` | `AdminUserController::delete` |
| POST | `/admin/users/wipe` | `AdminUserController::wipe` |

### Admin hosts

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/admin/hosts` | `AdminOverviewController::hosts` (or SPA for browsers) |
| GET | `/admin/hosts/insecure` | `AdminOverviewController::hostsInsecure` |
| POST | `/admin/hosts/register` | `AdminHostController::register` |
| GET | `/admin/hosts/{id}/detail` | `AdminOverviewController::hostDetail` |
| GET | `/admin/hosts/{id}/auth` | `AdminHostController::auth` |
| DELETE | `/admin/hosts/{id}` | `AdminHostController::delete` |
| POST | `/admin/hosts/{id}/clear` | `AdminHostController::clear` |
| POST | `/admin/hosts/{id}/roaming` | `AdminHostController::roaming` |
| POST | `/admin/hosts/{id}/secure` | `AdminHostController::secure` |
| POST | `/admin/hosts/{id}/vip` | `AdminHostController::vip` |
| POST | `/admin/hosts/{id}/scaling-exempt` | `AdminHostController::scalingExempt` |
| POST | `/admin/hosts/{id}/auto-update` | `AdminHostController::autoUpdate` |
| POST | `/admin/hosts/{id}/insecure/enable` | `AdminHostController::insecureEnable` |
| POST | `/admin/hosts/{id}/insecure/disable` | `AdminHostController::insecureDisable` |
| POST | `/admin/hosts/{id}/curl-insecure` | `AdminHostController::curlInsecure` |
| POST | `/admin/hosts/{id}/reverse-dns` | `AdminHostController::reverseDns` |
| POST | `/admin/hosts/{id}/model` | `AdminHostController::model` |
| POST | `/admin/hosts/{id}/codex-version` | `AdminHostController::codexVersion` |
| POST | `/admin/hosts/{id}/agents-version` | `AdminHostController::agentsVersion` |
| POST | `/admin/hosts/insecure/extend` | `AdminOverviewController::hostsInsecureExtend` |
| POST | `/admin/hosts/insecure/disable-all` | `AdminOverviewController::hostsInsecureDisableAll` |
| GET | `/admin/insecure-approvals/pending` | `AdminHostController::insecureApprovalPending` |
| POST | `/admin/insecure-approvals/{id}/allow-domain` | `AdminHostController::insecureApprovalAllowDomain` |
| POST | `/admin/insecure-approvals/{id}/approve` | `AdminHostController::insecureApprovalApprove` |
| POST | `/admin/insecure-approvals/{id}/deny` | `AdminHostController::insecureApprovalDeny` |
| POST | `/admin/insecure-domain-allows/{id}/revoke` | `AdminHostController::insecureDomainRevoke` |

### Admin settings

| Method | Route | Handler |
|--------|-------|---------|
| GET/POST | `/admin/api/state` | `AdminSettingsController::getApiState/postApiState` |
| GET/POST | `/admin/cdx-silent` | `AdminSettingsController::getCdxSilent/postCdxSilent` |
| GET/POST | `/admin/theme` | `AdminSettingsController::getTheme/postTheme` |
| GET/POST | `/admin/reverse-dns` | `AdminSettingsController::getReverseDns/postReverseDns` |
| GET/POST | `/admin/auto-update` | `AdminSettingsController::getAutoUpdate/postAutoUpdate` |
| GET/POST | `/admin/insecure-approval` | `AdminSettingsController::getInsecureApproval/postInsecureApproval` |
| GET/POST | `/admin/quota-mode` | `AdminSettingsController::getQuotaMode/postQuotaMode` |
| POST | `/admin/prune-policy` | `AdminSettingsController::postPrunePolicy` |
| GET/POST | `/admin/log-retention` | `AdminSettingsController::getLogRetention/postLogRetention` |
| GET/POST | `/admin/scaling` | `AdminSettingsController::getScaling/postScaling` |
| GET/POST | `/admin/claude/state` | `AdminSettingsController::getClaudeApiState/postClaudeApiState` |
| GET/POST | `/admin/claude/settings` | `AdminSettingsController::getClaudeSettings/postClaudeSettings` |
| GET/POST | `/admin/claude/version` | `AdminSettingsController::getClaudeVersion/postClaudeVersion` |
| GET | `/admin/claude/usage/history` | `AdminSettingsController::getClaudeUsageHistory` |
| POST | `/admin/codex-version` | `AdminSettingsController::postCodexVersion` |
| POST | `/admin/versions/check` | `AdminSettingsController::versionsCheck` |

### Admin overview / dashboard

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/admin/overview` | `AdminOverviewController::overview` |
| GET | `/admin/ws/info` | `AdminOverviewController::wsInfo` |
| POST | `/admin/toasts` | `AdminOverviewController::toasts` |
| GET | `/admin/tokens` | `AdminOverviewController::tokens` |
| GET | `/admin/usage` | `AdminOverviewController::usage` |
| GET | `/admin/usage/ingests` | `AdminOverviewController::usageIngests` |
| GET | `/admin/chatgpt/usage` | `AdminOverviewController::chatgptUsage` |
| GET | `/admin/chatgpt/usage/history` | `AdminOverviewController::chatgptUsageHistory` |
| POST | `/admin/chatgpt/usage/refresh` | `AdminOverviewController::chatgptUsageRefresh` |
| GET | `/admin/runner` | `AdminOverviewController::runner` |
| POST | `/admin/runner/run` | `AdminOverviewController::runnerRun` |
| POST | `/admin/runner/run-claude` | `AdminOverviewController::runnerRunClaude` |
| POST | `/admin/auth/seed-command` | `AdminOverviewController::seedCommand` |
| POST | `/admin/auth/upload` | `AdminOverviewController::authUpload` |
| GET | `/admin/logs` | `AdminOverviewController::logs` (or SPA) |
| GET | `/admin/mcp/logs` | `AdminConfigController::mcpLogs` |

### Admin config / agents / skills / memories

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/admin/config` | `AdminConfigController::config` |
| POST | `/admin/config/render` | `AdminConfigController::configRender` |
| POST | `/admin/config/store` | `AdminConfigController::configStore` |
| GET | `/admin/agents` | `AdminConfigController::agents` |
| GET | `/admin/agents/versions/{id}` | `AdminConfigController::agentsVersion` |
| POST | `/admin/agents/store` | `AdminConfigController::agentsStore` |
| POST | `/admin/agents/serve` | `AdminConfigController::agentsServe` |
| POST | `/admin/agents/revert` | `AdminConfigController::agentsRevert` |
| POST | `/admin/agents/retention` | `AdminConfigController::agentsRetention` |
| DELETE | `/admin/agents/versions/{id}` | `AdminConfigController::agentsDeleteVersion` |
| GET | `/admin/mcp/memories` | `AdminConfigController::memories` |
| DELETE | `/admin/mcp/memories/{id}` | `AdminConfigController::memoriesDelete` |
| GET | `/admin/skills` | `AdminConfigController::skills` |
| GET | `/admin/skills/{slug}` | `AdminConfigController::skillShow` (or SPA) |
| POST | `/admin/skills/generate` | `AdminConfigController::skillGenerate` |
| POST | `/admin/skills/assist` | `AdminConfigController::skillAssist` |
| POST | `/admin/skills/store` | `AdminConfigController::skillStore` |
| DELETE | `/admin/skills/{slug}` | `AdminConfigController::skillDelete` |

### Admin projects

Every project endpoint lives on `AdminProjectController` and mirrors the host-facing `/projects/*` surface from `ProjectApiController`. See [projects](/admin/manual/projects) for the full shape.

### Admin manual

| Method | Route | Handler |
|--------|-------|---------|
| GET | `/admin/manual/manifest` | `AdminManualController::manifest` |
| GET | `/admin/manual/search` | `AdminManualController::searchIndex` |
| GET | `/admin/manual/article/{slug}` | `AdminManualController::article` |

### Host-facing and public routes

| Method | Route | Handler |
|--------|-------|---------|
| POST | `/auth` | `AuthController::auth` |
| POST | `/sync/status` | `AuthController::syncStatus` |
| POST | `/sync/bootstrap` | `AuthController::syncBootstrap` |
| DELETE | `/auth` | `AuthController::deleteAuth` |
| GET | `/wrapper` | `WrapperController::meta` |
| GET | `/wrapper/download` | `WrapperController::download` |
| GET | `/install/{token}` | `InstallController::install` |
| GET | `/seed/auth/{token}` | `InstallController::seedAuthScript` |
| POST | `/seed/auth/{token}` | `InstallController::seedAuthStore` |
| POST | `/cli/auth/start` | `CliAuthController::start` |
| POST | `/cli/auth/poll/{id}` | `CliAuthController::poll` |
| GET | `/cli/auth/verify` | `CliAuthController::verifyPage` |
| POST | `/cli/auth/lookup` | `CliAuthController::lookup` |
| POST | `/cli/auth/approve` | `CliAuthController::approve` |
| POST | `/cli/auth/deny` | `CliAuthController::deny` |
| POST | `/agents/retrieve` | `ConfigApiController::agentsRetrieve` |
| POST | `/config/retrieve` | `ConfigApiController::configRetrieve` |
| GET/POST | `/skills` | `SkillApiController::listSkills` |
| POST | `/skills/retrieve` | `SkillApiController::retrieveSkill` |
| POST | `/skills/store` | `SkillApiController::storeSkill` |
| POST | `/host/users` | `HostApiController::recordUsers` |
| GET/POST | `/host/lane` | `HostApiController::getLane/setLane` |
| POST | `/usage` | `HostApiController::recordUsage` |
| GET/POST | `/mcp` | `McpRouteController::probe/handle` |
| GET | `/versions` | `VersionController::index` |

### OpenAI- and Anthropic-compatible APIs

Under `/v1/*` — `OpenAiApiController` — and `/anthropic/v1/*` — `ClaudeApiController`. Each supports `chat/completions`, `responses`, `completions`, `embeddings`, `models`, plus CORS `OPTIONS`. Authentication is by `sk-coco-…` API key; the endpoints proxy through the shared runner with quota accounting.

## Source references

- public/index.php (canonical route registrations)
- public/admin/assets/dashboard.js (handleGlobalShortcut)
- public/admin/assets/nav.js (prefix arming, rail group toggling)
- public/admin/index.html (keyboard shortcut help grid)
- src/Http/Controllers/AdminPageController.php, AdminManualController.php (manual controllers)
