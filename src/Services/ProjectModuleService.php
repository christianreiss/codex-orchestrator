<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\VersionRepository;

class ProjectModuleService
{
    public const ENABLED_FLAG = 'projects_module_enabled';
    public const MANAGED_SKILL_SLUG = 'coco';
    public const MANAGED_SKILL_PATH = '~/.agents/skills/coco/SKILL.md';

    public function __construct(private readonly VersionRepository $versions)
    {
    }

    public function isEnabled(): bool
    {
        return $this->versions->getFlag(self::ENABLED_FLAG, false);
    }

    public function adminState(): array
    {
        $meta = $this->versions->getWithMetadata(self::ENABLED_FLAG);

        return [
            'enabled' => $this->isEnabled(),
            'updated_at' => $meta['updated_at'] ?? null,
            'managed_skill' => $this->managedSkillMetadata(),
        ];
    }

    public function setEnabled(bool $enabled): array
    {
        $this->versions->set(self::ENABLED_FLAG, $enabled ? '1' : '0');

        return $this->adminState();
    }

    public function managedSkill(): ?array
    {
        if (!$this->isEnabled()) {
            return null;
        }

        $manifest = $this->managedSkillManifest();
        $sha = hash('sha256', $manifest);
        $meta = $this->versions->getWithMetadata(self::ENABLED_FLAG);
        $skill = $this->managedSkillMetadata();

        return [
            'id' => null,
            'slug' => $skill['slug'],
            'sha256' => $sha,
            'display_name' => $skill['display_name'],
            'description' => $skill['description'],
            'manifest' => $manifest,
            'updated_at' => $meta['updated_at'] ?? null,
            'deleted_at' => null,
            'managed' => true,
        ];
    }

    public function bootstrapSkill(): array
    {
        return $this->managedSkillMetadata();
    }

    public function bootstrapInstructions(string $slug): array
    {
        $encodedSlug = rawurlencode($slug);
        $base = '/projects/' . $encodedSlug;

        return [
            'Read the managed `coco` skill at ' . self::MANAGED_SKILL_PATH . ' for the full native toolkit, project-only workflow, and troubleshooting notes.',
            "Fetch the shared snapshot with GET {$base}/bootstrap or the MCP tool project_bootstrap.",
            "Inspect durable project context with GET {$base} or the MCP tool project_detail.",
            'Cross-server CoCo is project-only: do not use `memory://...` resources or `coco*` MCP memory ids for shared handoffs; those remain host-scoped.',
            "Review open work with GET {$base}/todos and recent notes with GET {$base}/notes before making changes.",
            "Capture only durable state: notes for decisions, todos for actions, files for artifacts, feedback for blockers and feature requests.",
            "Replay incremental updates with GET {$base}/changes?since=<last-seq> or the MCP tool project_changes before overwriting shared data.",
        ];
    }

    public function bootstrapQuickstart(string $slug): array
    {
        $escapedSlug = addslashes($slug);

        return [
            'project_list',
            'project_bootstrap {"slug":"' . $escapedSlug . '"}',
            'project_changes {"slug":"' . $escapedSlug . '","since":0}',
            'project_note_upsert {"slug":"' . $escapedSlug . '","header":"Sync status","body":"..."}',
            'project_todo_create {"slug":"' . $escapedSlug . '","title":"Next action","detail":"..."}',
            'project_file_upsert {"slug":"' . $escapedSlug . '","stored_name":"notes/rollout.md","content":"..."}',
        ];
    }

    private function managedSkillManifest(): string
    {
        return $this->toolkitMarkdown(true);
    }

    /**
     * @return array{slug:string,display_name:string,description:string,path:string}
     */
    private function managedSkillMetadata(): array
    {
        return [
            'slug' => self::MANAGED_SKILL_SLUG,
            'display_name' => 'CoCo Projects',
            'description' => 'Native project-only coordination workflow for codex-orchestrator, with the toolkit embedded in the skill itself.',
            'path' => self::MANAGED_SKILL_PATH,
        ];
    }

    private function toolkitMarkdown(bool $includeFrontMatter): string
    {
        $prefix = $includeFrontMatter ? <<<'MARKDOWN'
---
name: "CoCo Projects"
description: "Coordinate shared project state through the orchestrator's native project module. This skill also carries the CoCo toolkit/help."
---

MARKDOWN
            : '';
        $body = <<<'MARKDOWN'
# CoCo Toolkit (Codex Orchestrator Projects)

CoCo is the native shared-project coordination layer inside codex-orchestrator. Use it when work needs durable shared notes, todos, files, feedback, or resumable handoffs across agents instead of ad-hoc scratchpads or chat-only context.

Cross-server CoCo is project-only. Shared handoffs must live in a real project slug via `/projects/*`, `project_*` MCP tools, and `project://{slug}` resources. MCP `memory://...` resources remain host-scoped scratch space and are not a cross-host fallback.

This skill is the toolkit/help document. When the Projects module is enabled, codex-orchestrator auto-deploys it to `~/.agents/skills/coco/SKILL.md`; when the module is disabled, the managed skill is withdrawn on the next client sync.

## When to use it
- The user explicitly asks for `#coco`, shared coordination, or a project slug.
- Multiple agents or sessions need to share state.
- Decisions, action items, or artifacts should survive beyond the current chat.

## Primary interface: MCP
Inside Codex, prefer the built-in MCP tools over raw HTTP:
- `project_list` - discover available shared projects.
- `project_bootstrap` - pull the one-shot project snapshot you should read first.
- `project_detail` - inspect the full project state.
- `project_changes` - replay only new activity since the last known sequence.
- `project_note_upsert` - create or update durable decision notes.
- `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone` - manage the shared action queue.
- `project_file_upsert` - store or refresh shared artifacts.
- `project_feedback_create` - log bugs, blockers, or feature requests for later triage.

## Native REST surface
These host-authenticated routes back the same coordination flow:
- `GET /projects` - discover project slugs and summaries.
- `POST /projects` - create a shared project.
- `GET /projects/{slug}` - full shared state.
- `GET /projects/{slug}/bootstrap` - compact onboarding snapshot with instructions, quickstart, skill metadata, and recent state.
- `POST /projects/{slug}/about` - update metadata.
- `POST /projects/{slug}/roster` - update the shared roster/brief.
- `GET /projects/{slug}/changes` - fetch change log entries (`?since=` supported).
- `GET/POST/DELETE` note, todo, file, and feedback subroutes under `/projects/{slug}/*`.

## Hard rule: no memory fallback
- Do not use `memory://...` resources for CoCo shared handoffs. They are scoped to the current authenticated host.
- Do not invent `coco.*`, `coco:...`, or similar MCP memory ids as pseudo-shared state. Those keys are reserved and rejected.
- If no shared project exists yet, create one first, then store the handoff there as notes, todos, files, or feedback.

## Project lifecycle
1. Identify the project slug. If none is given, call `project_list`.
2. Create the project first if it does not exist yet.
3. Call `project_bootstrap` immediately after landing.
4. Capture `latest_seq` and revisit `project_changes` before overwriting shared state.
5. Record decisions as notes, actionable work as todos, reusable artifacts as files, and blockers as feedback.

## Quickstart
MCP-first examples:

```json
{"name":"project_list","arguments":{}}
{"name":"project_bootstrap","arguments":{"slug":"apollo"}}
{"name":"project_changes","arguments":{"slug":"apollo","since":0}}
{"name":"project_note_upsert","arguments":{"slug":"apollo","header":"Sync status","body":"Imported backlog and aligned the next steps."}}
{"name":"project_todo_create","arguments":{"slug":"apollo","title":"Next action","detail":"Describe the next meaningful step."}}
{"name":"project_file_upsert","arguments":{"slug":"apollo","stored_name":"notes/rollout.md","content":"# Rollout notes"}}
```

REST fallback:

```bash
curl -s -H "Authorization: Bearer $HOST_API_KEY" "$COORDINATOR_BASE_URL/projects/apollo/bootstrap"
curl -s -H "Authorization: Bearer $HOST_API_KEY" "$COORDINATOR_BASE_URL/projects/apollo/changes?since=0"
```

## Coordination patterns
- Bootstrap first. Read the snapshot before creating or updating project state.
- Use notes for durable decisions and findings. Put one decision per note when possible.
- Use todos for actionable work. Keep them small, specific, and easy to mark done.
- Use files for artifacts that should be reused later: runbooks, snippets, checklists, outputs.
- Use feedback for blockers and infrastructure gaps that need later follow-up.
- Keep updates factual and incremental; prefer updating existing shared state over creating duplicates.

## Automation tips
- Slug rule: `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`.
- Project-scoped writes require an existing slug. Create the project first and wait for success before writing notes, todos, files, or feedback.
- Compare `updated_at` and `latest_seq` before overwriting shared state touched by another agent.
- The bootstrap payload already includes `instructions`, `quickstart`, `skill`, and canonical routes. Reuse it instead of inventing a fresh onboarding checklist.
- CoCo handoffs are shared only through projects. MCP memories stay host-scoped and are intentionally blocked for reserved `coco*` ids.
- REST calls require the normal host API key and IP-bound auth rules; MCP calls inherit that auth through the baked client config.
- Do not paste huge bootstrap payloads back into the conversation when a short summary will do.

## Troubleshooting
- `404 Project coordination disabled` means the module is off.
- `404 Project not found` usually means the slug was never created or was mistyped.
- An empty `project_list` means no shared workspace exists yet. Create the project instead of falling back to MCP memory.
- `422` indicates validation failure; inspect the returned field errors.
- `401/403` on REST usually means missing host auth, IP binding problems, or installation mismatch.
- If coordination primitives are missing or insufficient, create a feedback item instead of branching into side-channel tracking.

Stay within these primitives for predictable collaboration and let higher-level playbooks build on top.
MARKDOWN;

        return $prefix . $body;
    }
}
