<?php

declare(strict_types=1);

namespace App\Services;

use App\Repositories\VersionRepository;

class ProjectModuleService
{
    public const ENABLED_FLAG = 'projects_module_enabled';
    public const MANAGED_SKILL_SLUG = 'coco';

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
            'managed_skill' => [
                'slug' => self::MANAGED_SKILL_SLUG,
                'display_name' => 'CoCo Projects',
                'description' => 'Native project coordination workflow for codex-orchestrator.',
            ],
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

        return [
            'id' => null,
            'slug' => self::MANAGED_SKILL_SLUG,
            'sha256' => $sha,
            'display_name' => 'CoCo Projects',
            'description' => 'Coordinate work through the orchestrator project module.',
            'manifest' => $manifest,
            'updated_at' => $meta['updated_at'] ?? null,
            'deleted_at' => null,
            'managed' => true,
        ];
    }

    private function managedSkillManifest(): string
    {
        return <<<'MARKDOWN'
---
name: "CoCo Projects"
description: "Coordinate shared project state through the orchestrator's native project module."
---

# What this skill does
Use the built-in project coordination tools from the orchestrator MCP server to share notes, todos, files, feedback, and project context across agents.

## When to use
- The user asks to coordinate work across multiple agents.
- The user references a project slug or wants a shared project brief/status area.
- You need durable notes, todos, or files that should survive across sessions.

## Workflow
1. Identify the project slug. If none is given, inspect the available projects first.
2. Pull the current context with `project_list` or `project_bootstrap`.
3. Record durable decisions with `project_note_upsert`.
4. Track actionable work with `project_todo_create`, `project_todo_update`, and the done/undone tools.
5. Store reusable artifacts with `project_file_upsert`.
6. Check `project_changes` before overwriting shared state if other agents may be working in parallel.

## Rules
- Keep updates small and factual.
- Prefer updating existing shared state over creating duplicates.
- Use feedback entries for bugs/feature requests that should be triaged later.
- Do not paste huge bootstrap payloads into context when a short summary is enough.
MARKDOWN;
    }
}
