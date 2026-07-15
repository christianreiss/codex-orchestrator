import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { versions } from '../db/schema.js';

export const PROJECTS_ENABLED_FLAG = 'projects_module_enabled';
export const MANAGED_COCO_SKILL_SLUG = 'coco';
export const MANAGED_COCO_DISPLAY_NAME = 'CoCo Project Coordination';
export const MANAGED_COCO_DESCRIPTION =
  'Use #coco to coordinate shared handoffs through project_* MCP tools and project:// resources.';

const MANAGED_COCO_MANIFEST = `---
name: coco
description: "${MANAGED_COCO_DESCRIPTION}"
---

# CoCo Project Coordination

Use #coco when work needs shared multi-agent state across hosts or sessions.

CoCo state is project-only:
- Start by reading project_bootstrap for the active slug.
- Use project_list or project_create to find or create shared workspaces.
- Use project_detail and project_changes to refresh context before acting.
- Write durable handoffs with project_note_upsert, project_todo_create, project_todo_update, project_todo_done, project_todo_undone, project_file_upsert, project_memory_upsert, and project_feedback_create.
- Read shared artifacts with project_file_list, project_file_read, project_memory_list, project_memory_get, project://{slug}, project://{slug}/files/{stored_name}, and project://{slug}/memory/{key}.

Use project_memory_* for durable shared memory: those rows are project-scoped and visible from every host. Do not use memory:// resources or mcp_memories for cross-host CoCo handoffs; those remain host-scoped.
`;

export interface ManagedCocoSkill {
  slug: string;
  sha256: string;
  display_name: string;
  description: string;
  manifest: string;
  updated_at: string;
  deleted_at: null;
  engine: null;
  uri: string;
  canonical_uri: string;
  managed: true;
}

export function managedCocoSkillUri(): string {
  return `skill://${MANAGED_COCO_SKILL_SLUG}`;
}

export function isManagedCocoSlug(slug: string): boolean {
  return slug.trim().toLowerCase() === MANAGED_COCO_SKILL_SLUG;
}

export function managedCocoManifest(): string {
  return MANAGED_COCO_MANIFEST;
}

export function buildManagedCocoSkill(updatedAt: string): ManagedCocoSkill {
  const manifest = managedCocoManifest();
  return {
    slug: MANAGED_COCO_SKILL_SLUG,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    display_name: MANAGED_COCO_DISPLAY_NAME,
    description: MANAGED_COCO_DESCRIPTION,
    manifest,
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: managedCocoSkillUri(),
    canonical_uri: managedCocoSkillUri(),
    managed: true,
  };
}

export async function getManagedCocoSkillIfEnabled(db: Database): Promise<ManagedCocoSkill | null> {
  const rows = await db
    .select()
    .from(versions)
    .where(eq(versions.name, PROJECTS_ENABLED_FLAG))
    .limit(1);
  const row = rows[0];
  if (row?.version !== '1') return null;
  return buildManagedCocoSkill(row.updatedAt);
}

export function managedCocoBootstrapGuidance(): {
  skill: { slug: string; uri: string; canonical_uri: string; managed: true };
  instructions: string;
  quickstart: string[];
} {
  return {
    skill: {
      slug: MANAGED_COCO_SKILL_SLUG,
      uri: managedCocoSkillUri(),
      canonical_uri: managedCocoSkillUri(),
      managed: true,
    },
    instructions:
      'Use #coco with project_* MCP tools and project:// resources only. Keep shared handoffs in project notes, todos, files, memories, feedback, and changes; host-scoped memory:// entries are not shared CoCo state — use project_memory_* for durable memory that every host can see.',
    quickstart: [
      'Read project_bootstrap for the slug before acting.',
      'Use project_changes since the last known seq to catch up.',
      'Use project_memory_list to enumerate durable project memory without guessing search terms.',
      'Write durable results with project_note_upsert, project_todo_* tools, project_file_upsert, project_memory_upsert, or project_feedback_create.',
    ],
  };
}
