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

CoCo coordination state is project-only — projects carry notes, todos, files, feedback and an append-only event log, none of which shared memories have:
- Start by reading project_bootstrap for the active slug.
- Use project_list or project_create to find or create shared workspaces.
- Use project_detail and project_changes to refresh context before acting.
- Write durable handoffs with project_note_upsert, project_file_upsert, project_memory_upsert, and project_feedback_create.
- Read shared artifacts with project_file_list, project_file_read, project_memory_list, project_memory_get, project://{slug}, project://{slug}/files/{stored_name}, and project://{slug}/memory/{key}.

Coordinated work lives on the project board, not in a list. Call project_board_list **first** — it needs no arguments and tells you which columns exist, which cards are free, and who holds what:
- Claim a card with project_card_claim and the role you are working in (plan, code, review, verify, ops) BEFORE you start. Pass worktree_path and username: they bind the claim to this session, and without them a card you abandon stays stuck for half an hour instead of being freed the moment the session ends.
- Move it with project_card_move as it progresses, and project_card_release the moment you stop rather than simply stopping. Releasing advances the card to the next column on its own, so you do not have to know what comes next; pass resolution "blocked" with a note when you are stuck, or "handoff" to leave it where it is for somebody else.
- Any call naming a card renews your claim, so a long task keeps its card. project_card_get is the cheapest way to do that and also shows the card's recent history.
- Claims and moves are advice, not locks. Nothing stops you working on a card somebody else holds — but unclaimed work is invisible to every other agent, and that is the whole cost. A move into a column your role does not cover still happens and comes back with an advisory.
- project_todo_* still works and writes the same cards: a todo id is its card number. It sees only "done or not", so prefer the board when the pipeline matters.

Pick the right memory substrate — there are three and they are not interchangeable:
- project_memory_* — short durable facts belonging to THIS workstream. Project-scoped, visible from every host, one fact per key.
- shared_memory_* — fleet-wide reference documents that outlive any single project: runbooks, architecture notes, accumulated findings. Scoped to neither host nor project, up to 1 MiB each, chunked and searchable. Start with shared_memory_list (it needs no query), narrow with shared_memory_search, read with shared_memory_read. Append for concurrency, replace for correction: shared_memory_append adds new material without a read-modify-write race. Before replacing an existing shared document through shared_memory_write or resource_create/resource_update on shared://, reconstruct the complete body from offset 0 through every next_offset with one stable memory.sha256, preserve unaffected content, and pass that digest as expected_sha256. Never replace from an excerpt, preview, chunk, or partial read. Use shared_memory_delete or resource_delete on shared:// only when the whole record is invalid or superseded. Appending beside a stale fact leaves both standing, and the next agent cannot tell which one is true.
- memory_* / memory:// — host-scoped scratch. Never valid for cross-host handoffs, and it cannot be listed, so another agent cannot discover what it holds.

Choosing between them: if the next agent on a DIFFERENT project would want it, it is a shared memory. If it is a sentence you would tell the next agent on THIS work, it is a project memory. If it is something they would copy or run, it is a project file — store those under stable names beginning \`context/\`.

Bootstrap before acting, even when the task looks self-evident:
1. shared_memory_list for the fleet-wide index (it needs no query, so never guess search terms), narrow with shared_memory_search, then shared_memory_read what the task touches. Reads come back windowed: follow next_offset while truncated is true.
2. Resolve the project slug — an explicit slug wins, otherwise derive it from the git repo or working directory and confirm with project_list. Never invent one.
3. project_bootstrap, then project_memory_list for the full index, then project_memory_get for the entries the task touches.
4. project_file_list, then project_file_read for artifacts the task needs.
5. If resuming, project_changes since the stored latest_seq. It returns at most 200 events per call, so iterate until you reach latest_seq.
6. State in one line what you loaded and what you believe the current state is, then act.
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
      'Use #coco with project_* MCP tools and project:// resources for coordination. Coordinated work lives on the project board — call project_board_list first, claim a card with your role before starting, and release it when you stop. Keep handoffs in project notes, files, memories, feedback, and changes; host-scoped memory:// entries are not shared CoCo state. Use project_memory_* for facts about this workstream, and shared_memory_* for fleet-wide reference documents that outlive it.',
    quickstart: [
      'Read project_bootstrap for the slug before acting.',
      'Use project_changes since the last known seq to catch up.',
      'Use project_memory_list to enumerate durable project memory without guessing search terms.',
      'Call project_board_list before picking up work: it needs no arguments and shows which cards are free and who holds the rest. Claim one with project_card_claim and your role, passing worktree_path and username, and project_card_release it the moment you stop.',
      'Write durable results with project_note_upsert, project_file_upsert, project_memory_upsert, or project_feedback_create.',
      'For knowledge that is not specific to this project, use shared_memory_list to see what the fleet already knows, then shared_memory_write or shared_memory_append.',
      'If anything you read turns out to be wrong, correct it before you finish. Before replacing an existing shared document through shared_memory_write or resource_create/resource_update on shared://, reconstruct the complete body from offset 0 through every next_offset with one stable memory.sha256, preserve unaffected content, and pass it as expected_sha256. Use shared_memory_delete or resource_delete on shared:// only when the whole record is invalid or superseded. Do not leave the correction sitting next to the stale record.',
    ],
  };
}
