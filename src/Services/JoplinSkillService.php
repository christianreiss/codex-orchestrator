<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\VersionRepository;

class JoplinSkillService
{
    public const ENABLED_FLAG = 'joplin_enabled';
    public const MANAGED_SKILL_SLUG = 'joplin';
    public const MANAGED_SKILL_URI = 'skill://joplin';

    public function __construct(private readonly VersionRepository $versions)
    {
    }

    public function isEnabled(): bool
    {
        return $this->versions->getFlag(self::ENABLED_FLAG, false);
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
            'uri' => $skill['uri'],
            'sha256' => $sha,
            'display_name' => $skill['display_name'],
            'description' => $skill['description'],
            'manifest' => $manifest,
            'updated_at' => $meta['updated_at'] ?? null,
            'deleted_at' => null,
            'managed' => true,
        ];
    }

    private function managedSkillMetadata(): array
    {
        return [
            'slug' => self::MANAGED_SKILL_SLUG,
            'uri' => self::MANAGED_SKILL_URI,
            'display_name' => 'Joplin Notes',
            'description' => 'Search, create, read, update, and delete notes in your Joplin notebook via MCP tools.',
        ];
    }

    private function managedSkillManifest(): string
    {
        return <<<'MANIFEST'
---
name: Joplin Notes
description: Search, create, read, update, and delete notes in your Joplin notebook via MCP tools.
tags:
  - notes
  - joplin
  - productivity
---

# Joplin Notes

This skill provides access to your Joplin notes server through MCP tools. Use it to store information, retrieve notes, and manage your knowledge base.

## When to Use This Skill

Use this skill when you need to:
- Search through your Joplin notes by keyword or topic
- Read the full content of a specific note
- Create a new note to store information, summaries, or findings
- Update an existing note with new information
- Delete notes that are no longer needed
- Browse notebooks to understand your note structure

## Step-by-Step Instructions

### Searching Notes
Call the `joplin_search` MCP tool with a query string. It returns matching notes with title and body excerpt.

### Reading a Note
Call the `joplin_get_note` MCP tool with the `note_id` from a search result to read the full note content.

### Listing Notebooks
Call the `joplin_list_notebooks` MCP tool to see available notebooks and their IDs.

### Creating a Note
Call the `joplin_create_note` MCP tool with:
- `title` — note title
- `body` — note content in Markdown
- `notebook_id` (optional) — ID of the notebook to place it in
- `tags` (optional) — array of tag names

### Updating a Note
Call the `joplin_update_note` MCP tool with `note_id` and any fields to change (`title`, `body`, `notebook_id`, `tags`).

### Deleting a Note
Call the `joplin_delete_note` MCP tool with the `note_id`. This is permanent.
MANIFEST;
    }
}
