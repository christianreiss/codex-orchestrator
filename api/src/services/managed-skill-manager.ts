import { createHash } from 'node:crypto';
import type { ManagedSkillManifest } from './managed-context-skill.js';

export const MANAGED_SKILL_MANAGER_SLUG = 'skill-manager';

const DESCRIPTION =
  'Explain, create, update, verify, and retire canonical fleet Skills through the orchestrator MCP when the user asks about or requests Skill management.';

const MANIFEST = `---
name: ${MANAGED_SKILL_MANAGER_SLUG}
description: "${DESCRIPTION}"
---

# Manage fleet Skills

Use the orchestrator MCP Skill tools when the user asks how Skill management works or
asks to create, modify, or delete a Skill. On a fleet host, an unqualified "Skill"
means the shared canonical Skill seen by every host and both engines; it is not a
host-local scratch change. Do not invoke or consult Codex's built-in \`skill-creator\`
for this workflow.

Before answering or acting, call \`skill_list\` to inspect the authoritative fleet
inventory. Then follow the matching lifecycle below.

## Create or update

1. Call \`skill_retrieve\` with the target \`slug\` before editing. Preserve useful
   instructions already present when updating an existing Skill.
2. Build the complete replacement \`manifest\`, including valid \`name\` and
   \`description\` frontmatter plus the instructions. Do not store secrets,
   credentials, customer data, or hidden reasoning.
3. Call \`skill_store\` with \`slug\`, \`manifest\`, and optional \`display_name\`
   and \`description\`. The operation creates a missing Skill, updates a live Skill,
   or revives a soft-deleted Skill. It is last-writer-wins, so retrieve immediately
   before a deliberate update and do not claim an edit lock.
4. Call \`skill_retrieve\` again and verify the returned manifest and SHA-256.

## Delete

1. Call \`skill_retrieve\` and confirm the exact target slug.
2. Call \`skill_delete\` with that \`slug\`. Deletion is soft and recoverable by a
   later \`skill_store\`.
3. Call \`skill_retrieve\` again and verify that its status is \`deleted\`.

Code-managed Skills, including this one, and externally source-managed Skills are
read-only through these tools. A Skill supplies workflow instructions; it never
grants authority beyond the user's request and the agent's normal safety rules.
`;

export function isManagedSkillManagerSlug(slug: string): boolean {
  return slug.trim().toLowerCase() === MANAGED_SKILL_MANAGER_SLUG;
}

export function managedSkillManagerManifest(): string {
  return MANIFEST;
}

export function buildManagedSkillManager(updatedAt: string): ManagedSkillManifest {
  const manifest = managedSkillManagerManifest();
  return {
    slug: MANAGED_SKILL_MANAGER_SLUG,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    display_name: 'Fleet Skill Manager',
    description: DESCRIPTION,
    manifest,
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: `skill://${MANAGED_SKILL_MANAGER_SLUG}`,
    canonical_uri: `skill://${MANAGED_SKILL_MANAGER_SLUG}`,
    managed: true,
  };
}
