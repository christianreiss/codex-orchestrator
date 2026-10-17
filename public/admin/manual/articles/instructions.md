---
title: Agent rules (fleet instructions)
section: Admin workspace
summary: The generated AGENTS.md / CLAUDE.md: generation switch, policy modules, versions, security posture profiles, and the response-verbosity dial.
tags: [agents.md, claude.md, policy, instructions]
verified: 2026-10-17
sources: api/src/routes/admin/config/index.ts, api/src/routes/admin/settings/index.ts, api/src/services/agents.ts, api/src/services/agents-generation-mode.ts, api/src/services/agent-policy-profiles.ts, api/src/services/agent-security-levels.ts, api/src/services/agent-response-style.ts, api/src/services/host-agents.ts, api/src/services/managed-agents-features.ts, api/src/security/route-capabilities.ts, frontend/src/routes/(library)/library/agent-rules/+page.svelte, frontend/src/lib/components/library/agent-rules/rules-doc.svelte.ts, frontend/src/lib/api/agents.ts, frontend/src/lib/components/settings/SecurityLevelsPanel.svelte, frontend/src/lib/components/settings/ResponseVerbosityPanel.svelte
---

**Agent rules** (fleet instructions; `/library/agent-rules`, in the Library — the old `/instructions` and `/authoring/*` URLs redirect there) is where the shared agents document comes from — served to Codex hosts as `AGENTS.md`, to Claude hosts as `CLAUDE.md`, and to Grok hosts as `~/.grok/AGENTS.md` (see [Grok Build](cgx)) through the wrappers' bootstrap sync and `POST /agents/retrieve`. The page holds the document builder, its version history, the fleet's security posture, and the response-verbosity dial.

## Generation switch

The **AGENTS.md generation** control, under **Advanced** on the page (collapsed unless the fleet is already off the default; headed *How the document is produced*) (`GET`/`POST /admin/agents-generation-mode`, `settings.read` / `settings.manage`) has three positions, stored as `managed`, `manual`, and `off`:

| Position | Effect |
|---|---|
| **Generated** (`managed`) | The policy modules and custom instructions are composed into the document. |
| **Manual** (`manual`) | The builder is replaced by a raw Markdown editor; what you write is what is served. |
| **Disabled** (`off`) | The optional modules are not served. Hosts still receive the mandatory fleet policy, your custom instructions, and the host capability guidance. |

The switch is fleet-wide, applies the moment it is picked, and saves no version: the stored module selection survives a trip through *Disabled* and comes back untouched.

## The builder

In the **What goes in** block, **Always included** shows the mandatory fleet policy and **Optional modules** are the switches for each policy module; **Custom instructions** holds free-form house rules. The page composes the live preview on the right through `POST /admin/agents/compose` (`content.read`) as you edit; **Save** in the page header writes a new version with `POST /admin/agents/store` (`content.manage`). Only the canonical base is stored — the Skills, Memory, Projects, BrowserOS, Secrets, Agent Messaging, Git Director, and File Transfer guidance is appended per host at render time, according to which modules that host has enabled (`api/src/services/host-agents.ts`, `managed-agents-features.ts`). The live preview's scope switch (**Effective document** or **Canonical base**) and the **Preview effective draft** dialog (the **Effective AGENTS.md draft document**) render that per-host result (`GET`/`POST /admin/agents/render`) for a chosen host and engine so you can see what an agent actually reads; **Managed feature state** explains which sections were included and why.

The **History & publishing** button in the page header opens a sheet with the **Version history** (click a version for a read-only preview, `GET /admin/agents/versions/{id}`, then **Make current** to restore it, `POST /admin/agents/revert`), **Which version hosts get** (**Serve mode**, `POST /admin/agents/serve`: **Latest** or **Locked at version** with a version id, then **Apply**), and **Retention** (`POST /admin/agents/retention`, how many old versions to keep). The `DELETE /admin/agents/versions/{id}` route exists, but the page no longer offers a delete button. `AgentsService` (`api/src/services/agents.ts`) reconciles serve mode, latest version, and the canonical content hash that hosts compare against.

A host can also be pinned to a specific version from its detail page (**Advanced → Per-host exceptions → Agent rules document**, `POST /admin/hosts/{id}/agents-version`); see [Hosts](/admin/manual/hosts).

## Security posture

The **How cautious agents are** block (the **security levels** panel, saved separately with **Save posture**) edits an *agent policy profile*: nine axes — `autonomy`, `git_history`, `remote_hosts`, `deploy_release`, `destructive_data`, `secrets_exposure`, `security_controls`, `dependencies`, `verification_waiver` — each set to one of five bands, **Refuse**, **Ask**, **On request**, **Announce**, **Proceed**. A handful of presets (`SECURITY_PRESETS`) fill the vector; nudging any axis shows how far the profile has drifted from the nearest preset. Each axis declares how it is enforced — mechanically in the rendered document and served settings, partially, or as prose only — and the panel labels a step *prose only* where the neighbouring level would produce the same configuration.

Profiles are rows in `agent_policy_profiles` (`GET`/`POST /admin/agent-policy-profiles`, `POST`/`DELETE /admin/agent-policy-profiles/{id}`, all `content.read` / `content.manage`). One profile is the fleet default (`POST /admin/agent-policy-profiles/{id}/default`); `POST /admin/agent-policy-profiles/assign` binds a host to a different profile, or with `profile_id: null` clears it back to the default. `GET /admin/agent-policy-profiles/enforcement` reports what each axis level actually changes.

The **API keys in chat** switch (shown as *Tell agents how to treat keys pasted in chat*, under **Settings → Agents**, `/settings#agents`; `GET`/`POST /admin/api-keys-in-chat`) is a related fleet instruction injected into the same managed documents; see [Engines, Policies, and API Access](/admin/manual/settings).

## Response verbosity

The **response verbosity** slider, in the same *How cautious agents are* block and saved with **Save verbosity** (`GET`/`POST /admin/response-verbosity`, `settings.read` / `settings.manage`) is a fleet-wide level from 0 to 4 — **Full**, **Trimmed**, **Concise**, **Brief**, **Minimal** (`api/src/services/agent-response-style.ts`). It has two halves: a policy paragraph in the managed document, and, for Claude hosts, a named output style from the seeded rows — Claude Code resolves that style by its frontmatter `name`, which is why those rows are seeded rather than free-form (see [Subagents, Commands, and Output Styles](/admin/manual/claude-artifacts); the console calls output styles *reply styles*).

## Roles

Reading the document, versions, previews, and profiles is `content.read` (every role). Saving, restoring, deleting, serve mode, retention, and profile changes are `content.manage` (owner/admin). The generation switch and the verbosity dial are settings, so `settings.manage` — owner, admin, and fleet operator.

## Source references

- api/src/routes/admin/config/index.ts (`/admin/agents*` and `/admin/agent-policy-profiles*` routes)
- api/src/routes/admin/settings/index.ts (`/admin/agents-generation-mode`, `/admin/response-verbosity`, `/admin/api-keys-in-chat`)
- api/src/services/agents.ts (versions, serve mode, retention, canonical hash)
- api/src/services/agents-generation-mode.ts (`managed` / `manual` / `off`)
- api/src/services/agent-policy-profiles.ts, api/src/services/agent-security-levels.ts (profiles, the nine axes, five bands, presets, enforcement)
- api/src/services/agent-response-style.ts (verbosity levels 0–4 and their labels)
- api/src/services/host-agents.ts, api/src/services/managed-agents-features.ts (per-host render: which module sections are appended)
- api/src/security/route-capabilities.ts (`content.*` vs `settings.*` on this page)
- frontend/src/routes/(library)/library/agent-rules/+page.svelte, frontend/src/lib/components/library/agent-rules/rules-doc.svelte.ts (builder, generation switch, serve mode, retention, previews)
- frontend/src/lib/api/agents.ts (queries and mutations)
- frontend/src/lib/components/settings/SecurityLevelsPanel.svelte, frontend/src/lib/components/settings/ResponseVerbosityPanel.svelte (posture sliders, verbosity dial)
