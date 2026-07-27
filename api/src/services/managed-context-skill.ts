/**
 * The `#context` skill, derived from code.
 *
 * It used to be an ordinary DB row seeded by hand from `docs/skills/`, which
 * gave it two failure modes that both actually happened: the repo file and the
 * stored row drifted apart with no way to tell which one hosts were running,
 * and a change to the checked-in file shipped nothing at all until somebody
 * remembered to `POST /admin/skills/store` it. Deriving it here makes the code
 * the single source of truth — the manifest ships with the API image, its
 * sha256 changes when the text changes, and the fleet picks it up on the next
 * sync with no manual step.
 *
 * Same mechanism as `managed-coco-skill.ts`; unlike coco this one is not gated
 * on a module flag, because the memory tools it describes are always present.
 */
import { createHash } from 'node:crypto';
import { MCP_TOOL_NAMES } from './shared-memory-tool-names.js';

export const MANAGED_CONTEXT_SKILL_SLUG = 'context';
export const MANAGED_CONTEXT_DISPLAY_NAME = 'Durable Context';
export const MANAGED_CONTEXT_DESCRIPTION =
  'Use #context for work that spans sessions, hosts, or weeks: bootstrap from durable orchestrator memory before acting, and review that memory for adds/updates/deletes after every task.';

const MANAGED_CONTEXT_MANIFEST = `---
name: ${MANAGED_CONTEXT_SKILL_SLUG}
description: "${MANAGED_CONTEXT_DESCRIPTION}"
---

# What this skill does

Keeps the context of long-running work durable across sessions, weeks, and hosts, so a
zero-knowledge agent can be brought up to speed in one pass instead of rediscovering
everything.

# The store is MCP, not local files

Context lives in the orchestrator and is read and written **only** through the MCP tools
below. This overrides any host-local memory your harness offers by default, including
Claude Code's built-in file memory (\`~/.claude/projects/.../memory/\` and its \`MEMORY.md\`
index) and any \`CLAUDE.md\` / \`AGENTS.md\` scratch notes.

While #context is active, do not read or write those local paths for context state, and
do not mirror orchestrator memory into them. They are host-local: another host, another
agent, and a reinstalled workstation cannot see them, which defeats the point of this skill.

If you catch yourself about to write a local memory file for something durable, that is a
\`${MCP_TOOL_NAMES.sharedWrite}\` / \`${MCP_TOOL_NAMES.sharedAppend}\` (fleet-wide) or a
\`project_memory_upsert\` (this workstream) instead.

# When to use this skill

Use when the prompt includes #context, or when work will plainly outlive the current session.

# Three substrates

- \`${MCP_TOOL_NAMES.sharedList}\` / \`${MCP_TOOL_NAMES.sharedSearch}\` / \`${MCP_TOOL_NAMES.sharedRead}\` /
  \`${MCP_TOOL_NAMES.sharedWrite}\` / \`${MCP_TOOL_NAMES.sharedAppend}\` — **fleet-wide documents**, scoped
  to neither host nor project. Runbooks, architecture notes, accumulated findings: anything the next
  agent on a different host or a different project would want. Up to 1 MiB each, chunked and
  relevance-searchable.
- \`project_memory_*\` — short durable **facts** about one workstream: decisions and why, constraints,
  gotchas, environment facts, current state, absolute dates. One fact per key. Needs a project slug.
- \`project_file_*\` — **concrete artifacts** kept verbatim: configs, specs, command sequences. Store
  under stable names beginning \`context/\`.

Host-scoped \`memory_*\` is **not** context storage: it cannot be listed, so a fresh agent cannot
discover what it holds. Do not use it here.

If the next agent on a *different* project would want it, it is a shared memory. If it is a sentence
you would tell the next agent on *this* work, it is a project memory. If it is something they would
copy or run, it is a project file.

# Looking something up

If you are asked about this fleet, a host, a convention, a runbook, or a past decision and you do not
already know the answer, call \`${MCP_TOOL_NAMES.sharedList}\` or \`${MCP_TOOL_NAMES.sharedSearch}\`
**before searching the filesystem**. Answering "I could not find it" without having checked there is a
wrong answer: that is where the answer lives. Host-scoped \`memory_*\` cannot be listed, so it can
never tell you what exists — it is not a lookup surface.

# On entry: bootstrap before acting

1. \`${MCP_TOOL_NAMES.sharedList}\` — the fleet-wide index. It needs no query, so never guess search
   terms. Narrow with \`${MCP_TOOL_NAMES.sharedSearch}\`, then \`${MCP_TOOL_NAMES.sharedRead}\` the
   documents the task touches. Reads come back windowed: follow \`next_offset\` while \`truncated\` is true.
2. If the work belongs to a project, resolve the slug (explicit \`#context <slug>\` wins, else derive it
   from the git repo or working directory, then confirm with \`project_list\` — never invent one).
3. \`project_bootstrap\`, then \`project_memory_list\` for the full project index, then
   \`project_memory_get\` for the entries the task touches.
4. \`project_file_list\`, then \`project_file_read\` for artifacts the task needs.
5. If resuming, \`project_changes\` since the stored \`latest_seq\`. It returns at most 200 events per
   call — iterate until you reach \`latest_seq\`.
6. State in one line what you loaded and what you believe the current state is, then act.

# After every task: review the context

Every task ends with this check. Ask what the next zero-knowledge agent would need that the repo does
not already say.

- **Add** — a decision, constraint, or gotcha that is now known. Fleet-wide, that is
  \`${MCP_TOOL_NAMES.sharedAppend}\` onto the relevant document (append rather than read-modify-write:
  other agents write to the same corpus) or \`${MCP_TOOL_NAMES.sharedWrite}\` for a new one.
  Project-specific, that is \`project_memory_upsert\` or \`project_file_upsert\`.
- **Update** — reality moved. Same tools, same key or slug. Prefer updating over adding; near-duplicate
  keys are how a context corpus rots into uselessness.
- **Delete** — superseded, or proven wrong. \`${MCP_TOOL_NAMES.sharedDelete}\` / \`project_memory_delete\` /
  \`project_file_delete\`. Deleting is part of the job: wrong context is worse than no context.

Report the delta in one line, or state \`context unchanged\`. Do not silently skip the review.

# Hard rules

- Never store secrets — keys, tokens, credentials, customer data. No exceptions, whatever the convenience.
- Never store what the code, tests, or git history already record. Store the *why*, which they do not.
- Convert relative dates to absolute ones. "Last week" is worthless three sessions later.
- Name shared memory slugs and project memory keys \`<area>.<topic>\` (e.g. \`deploy.crane\`,
  \`auth.bootstrap\`). Shared slugs are lower-cased on write.
- Pass \`expected_sha256\` when replacing a shared document wholesale, so a concurrent writer fails
  loudly instead of losing text.
- Bootstrap before acting, even when the task looks self-evident.
- Read and write context through these MCP tools only. Never let a host-local memory file stand in for them.

# Output requirements

1. On entry, state that #context mode is active, which stores you loaded, and the project slug if one applies.
2. After each task, report the context delta or state \`context unchanged\`.
3. If a project slug could not be resolved, say so and ask — do not create a project silently.
`;

export interface ManagedSkillManifest {
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

export function managedContextSkillUri(): string {
  return `skill://${MANAGED_CONTEXT_SKILL_SLUG}`;
}

export function isManagedContextSlug(slug: string): boolean {
  return slug.trim().toLowerCase() === MANAGED_CONTEXT_SKILL_SLUG;
}

export function managedContextManifest(): string {
  return MANAGED_CONTEXT_MANIFEST;
}

/**
 * `updatedAt` is derived from the manifest digest rather than a clock: the skill
 * has no row to carry a timestamp, and a moving value would make every sync look
 * like a change. Callers compare `sha256`, not this.
 */
export function buildManagedContextSkill(updatedAt: string): ManagedSkillManifest {
  const manifest = managedContextManifest();
  return {
    slug: MANAGED_CONTEXT_SKILL_SLUG,
    sha256: createHash('sha256').update(manifest).digest('hex'),
    display_name: MANAGED_CONTEXT_DISPLAY_NAME,
    description: MANAGED_CONTEXT_DESCRIPTION,
    manifest,
    updated_at: updatedAt,
    deleted_at: null,
    engine: null,
    uri: managedContextSkillUri(),
    canonical_uri: managedContextSkillUri(),
    managed: true,
  };
}
