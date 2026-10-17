---
title: Subagents, Commands, and Output Styles
section: Admin workspace
summary: Claude-native collections: editing each kind, its frontmatter, and how clx writes and prunes them on hosts.
tags: [claude, subagents, commands, output-styles]
verified: 2026-10-17
sources: api/src/routes/admin/config/index.ts, api/src/services/claude-artifacts.ts, api/src/services/claude-frontmatter.ts, api/src/services/host-claude-artifacts.ts, api/src/routes/auth/index.ts, api/src/security/route-capabilities.ts, frontend/src/routes/(library)/library/+page.svelte, frontend/src/routes/(library)/library/[type]/[name]/+page.svelte, frontend/src/lib/components/library/ArtifactEditor.svelte, frontend/src/lib/components/library/LibraryList.svelte, frontend/src/lib/api/claudeArtifacts.ts, frontend/src/lib/constants/models.ts, wrappers/cxx/internal/persona/claude/lifecycle/collections.go
---

Claude Code reads three artifact *collections* off disk that Codex has no analogue for: subagents (`~/.claude/agents/`), slash commands (`~/.claude/commands/`), and output styles (`~/.claude/output-styles/`). The orchestrator manages them as fleet artifacts — one `claude_artifacts` row per item, discriminated by `kind` — and the **Library** edits them as three of its content types (chosen with the type filter): **Subagents** (`/library?type=subagents`), **Commands** (`?type=commands`), and **Reply styles** (`?type=output-styles`; output styles in Claude Code terms). They share one list-and-detail template with a different `kind`; the old `/subagents`, `/commands`, `/output-styles` and `/authoring/<kind>` URLs redirect to the Library. The Library marks these types as Claude-only: they sync to Claude Code hosts and are ignored by Codex and Grok.

## Listing and editing

Each Library list calls `GET /admin/claude/{kind}` (`content.read`) and links to `/library/<type>/<name>` (for example `/library/output-styles/<name>`), which loads `GET /admin/claude/{kind}/{slug}`. The detail editor writes the Markdown body plus the frontmatter Claude Code expects for that kind:

| Kind | Frontmatter fields the editor exposes |
|---|---|
| Subagent | `description`, `model` (a Claude model, or *inherit*), `color` (an eight-value palette), `tools` |
| Command | `description`, `argument_hint`, `model`, `allowed_tools` |
| Output style | `description` only |

**Save** posts to `POST /admin/claude/{kind}/store` and **Delete** calls `DELETE /admin/claude/{kind}/{slug}` (a soft delete); both need `content.manage` (owner/admin). `:kind` is normalized by `api/src/services/claude-frontmatter.ts`, so singular and plural forms are both accepted in the URL. There is no import or export control on these pages — an artifact enters the fleet through the editor or the API.

Output-style rows matter beyond the page: the fleet's response-verbosity dial (see [Agent rules](/admin/manual/instructions)) applies a *named* output style, and Claude Code keys its registry by each artifact's frontmatter `name`, not its slug — `api/test/unit/contract/output-style-name-parity.test.ts` pins the emitted names to the seeded rows.

## How they reach hosts

Artifacts are not fetched by a dedicated host route. `HostClaudeArtifactsService.bundle()` runs inside the wrapper's `POST /sync/bootstrap` round-trip — only for `engine=claude`; Codex hosts never see them — and returns the complete live set per kind so the wrapper can reconcile deletions, omitting the body of any item whose SHA already matches the digest the wrapper sent. `clx` then writes `~/.claude/agents/<slug>.md`, `commands/<slug>.md`, and `output-styles/<slug>.md`, tracking exactly the files it wrote per directory; pruning removes only manifest-recorded files that dropped out of the live set, so user-authored files in those directories are never touched. See [clx](/admin/manual/clx) for the merge and prune rules.

`claude_artifact.stored`, `claude_artifact.updated`, and `claude_artifact.deleted` invalidate all three list queries at once.

## Source references

- api/src/routes/admin/config/index.ts (`GET /admin/claude/:kind`, `GET /admin/claude/:kind/:slug`, `POST /admin/claude/:kind/store`, `DELETE /admin/claude/:kind/:slug`)
- api/src/services/claude-artifacts.ts (storage and soft delete)
- api/src/services/claude-frontmatter.ts (`:kind` normalization, frontmatter parsing)
- api/src/services/host-claude-artifacts.ts, api/src/routes/auth/index.ts (the bootstrap bundle that carries artifacts to Claude hosts)
- api/src/security/route-capabilities.ts (`content.read` / `content.manage`)
- frontend/src/routes/(library)/library/+page.svelte, frontend/src/lib/components/library/LibraryList.svelte (type filter and list)
- frontend/src/routes/(library)/library/[type]/[name]/+page.svelte, frontend/src/lib/components/library/ArtifactEditor.svelte (detail editors and their frontmatter fields)
- frontend/src/lib/api/claudeArtifacts.ts (shared query/mutation factory)
- frontend/src/lib/constants/models.ts (subagent colour palette, model options)
- wrappers/cxx/internal/persona/claude/lifecycle/collections.go (on-disk write and manifest-bound prune)
