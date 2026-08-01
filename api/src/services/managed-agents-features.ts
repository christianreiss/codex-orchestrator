/**
 * Pure, deterministic renderer for the feature guidance appended to served
 * AGENTS.md / CLAUDE.md documents. Capability discovery stays in
 * HostAgentsService; this module only turns resolved feature gates into text
 * and diagnostics.
 */
import { createHash } from 'node:crypto';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { buildManagedMemoryBlock, MANAGED_MEMORY_HEADING } from './managed-agents-memory.js';
import { HISTORIC_MANAGED_MEMORY_BLOCKS } from './managed-agents-memory-legacy.js';

export const MANAGED_FEATURES_START = '<!-- cxx:managed-features:start -->';
export const MANAGED_FEATURES_END = '<!-- cxx:managed-features:end -->';

export interface ManagedFeatureState {
  enabled: boolean;
  reason: string;
  count?: number;
}

export interface ManagedAgentFeatureContext {
  engine: Engine;
  skills: ManagedFeatureState;
  memory: ManagedFeatureState;
  projects: ManagedFeatureState;
  browseros: ManagedFeatureState;
  secrets: ManagedFeatureState;
}

export interface ManagedAgentFeatureSection {
  present: boolean;
  reason: string;
  count?: number;
  sha256?: string;
  transport?: 'mcp' | 'native';
}

export interface ManagedAgentFeatureSections {
  skills: ManagedAgentFeatureSection;
  memories: ManagedAgentFeatureSection;
  /** Compatibility alias for clients that consumed the former memory block. */
  memory_routing: ManagedAgentFeatureSection;
  projects: ManagedAgentFeatureSection;
  browseros: ManagedAgentFeatureSection;
  secrets: ManagedAgentFeatureSection;
}

export interface RenderManagedAgentFeaturesResult {
  body: string;
  managed_sha256: string | null;
  sections: ManagedAgentFeatureSections;
}

interface RenderedSection {
  text: string;
  metadata: ManagedAgentFeatureSection;
}

const OWN_BLOCK = new RegExp(
  `${escapeRegExp(MANAGED_FEATURES_START)}[\\s\\S]*?${escapeRegExp(MANAGED_FEATURES_END)}[ \\t]*(?:\\r?\\n)?`,
  'g',
);

// The old dynamic renderer used engine-specific inventory blocks. A served
// copy can later be pasted into the canonical editor, so replace all four
// variants rather than allowing the old and new guidance to accumulate.
const LEGACY_BLOCK =
  /<!--[ \t]*(cdx|clx):(skills|memories):start[ \t]*-->[\s\S]*?<!--[ \t]*\1:\2:end[ \t]*-->[ \t]*(?:\r?\n)?/g;

// managed-agents-memory.ts predates marker-delimited sections. Remove only
// the exact bytes emitted by that renderer (with or without its final LF).
// A heading-only regex would risk deleting operator-authored rules appended
// below a previously served copy.
//
// Regenerating from the current renderer only ever matches the CURRENT text, so
// every superseded wording is kept as an exact frozen literal in
// managed-agents-memory-legacy.ts. Without those, a canonical document holding a
// copy served under an older text would stop being stripped and the result would
// carry the stale doctrine beside the current one — the very failure the current
// block tells agents to avoid. Longest-first so a shorter entry can never eat a
// prefix of a longer one.
const LEGACY_MEMORY_BLOCKS = [...new Set(
  [
    ...[ENGINE_CODEX, ENGINE_CLAUDE].flatMap((engine) => {
      const block = buildManagedMemoryBlock(engine);
      return [block, block.replace(/\n$/, '')];
    }),
    ...HISTORIC_MANAGED_MEMORY_BLOCKS.flatMap((block) => [block, block.replace(/\n$/, '')]),
  ],
)].sort((a, b) => b.length - a.length);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function countMetadata(
  state: ManagedFeatureState,
): Pick<ManagedAgentFeatureSection, 'count'> | Record<string, never> {
  return state.count === undefined ? {} : { count: state.count };
}

function absent(state: ManagedFeatureState): ManagedAgentFeatureSection {
  return {
    present: false,
    reason: state.reason,
    ...countMetadata(state),
  };
}

function present(
  state: ManagedFeatureState,
  text: string,
  transport?: ManagedAgentFeatureSection['transport'],
): RenderedSection {
  return {
    text,
    metadata: {
      present: true,
      reason: state.reason,
      ...countMetadata(state),
      sha256: sha256(text),
      ...(transport === undefined ? {} : { transport }),
    },
  };
}

function skillsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.skills.enabled) return null;
  if (context.engine === ENGINE_CLAUDE) {
    return present(
      context.skills,
      `## Skills

Fleet Skills are synced as native Claude Code skills under
\`~/.claude/skills/<slug>/SKILL.md\`. Read the matching \`SKILL.md\` when a Skill's description or
trigger applies, and follow its instructions.`,
      'native',
    );
  }
  return present(
    context.skills,
    `## Skills

The orchestrator MCP is authoritative for fleet Skills. Before answering or acting on any
Skill-related request, call \`skill_list\` first — before reading any host-local or system
\`SKILL.md\`. For requests to create, update, delete, or explain the Skill-management workflow,
read \`skill://skill-manager\` with \`resource_read\` and follow it. Use \`skill_retrieve\` for
other manifests and \`skill://{slug}/<path>\` for support files. An unqualified "Skill" means a
fleet Skill; do not substitute Codex's built-in \`skill-creator\`.`,
    'mcp',
  );
}

function memorySection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.memory.enabled) return null;
  // Preserve the established routing contract verbatim; only demote its
  // heading so all feature providers share one managed top-level block.
  const text = buildManagedMemoryBlock(context.engine)
    .replace(MANAGED_MEMORY_HEADING, '## Memory')
    .replace(/\s+$/, '');
  return present(context.memory, text);
}

function projectsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.projects.enabled) return null;
  return present(
    context.projects,
    `## Projects / CoCo

Project coordination is enabled through MCP. Use \`#coco\` for its managed workflow and
\`project_*\` tools for shared project state, handoffs, and workstream memory. Start by reading
\`project_bootstrap\` for the active project — bootstrap before acting, even when the task looks
self-evident. The same curation rule as Memory applies here: correct a fact with
\`project_memory_upsert\` on the same key rather than adding a near-duplicate beside it.`,
  );
}

function browserOsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.browseros.enabled || context.engine !== ENGINE_CODEX) return null;
  return present(
    context.browseros,
    `## BrowserOS

A local BrowserOS MCP server is enabled for this Codex host. Use its browser tools when a task
requires interactive browser automation or live page inspection.`,
  );
}

/**
 * One text for both engines, with no engine branch. Unlike Skills — where
 * Claude Code has a native `~/.claude/skills/` loader to defer to — neither
 * engine ships a credential store of its own, so there is nothing to
 * differentiate and the rendered bytes are identical either way.
 *
 * The block does not enumerate slugs. `docs/interface-cdx.md` pins the contract
 * ("never lists individual Skills, memories, or projects"), enumerating would
 * rewrite every host's document on every secret added or renamed, and writing
 * credential *names* to disk cuts against a feature whose premise is that
 * nothing lands on the host. Making the agent spend one `secret_list` call is
 * the correct trade.
 */
function secretsSection(context: ManagedAgentFeatureContext): RenderedSection | null {
  if (!context.secrets.enabled) return null;
  return present(
    context.secrets,
    `## Secrets

This fleet keeps working credentials — API tokens, database passwords, service accounts — in the
orchestrator secrets store, shared across every host and both engines. It is reachable only
through MCP; nothing is written to this machine's disk.

**Needing a credential.** If a task needs a token, key, password, or connection string, call
\`secret_list\` (it takes no arguments) or \`secret_search\` **first — before asking the human, and
before hunting through env files, config files, or shell history**. Read the match with
\`secret_get\`. Asking for a credential the store already holds is a wrong answer: that is where
it lives.

**Checking or storing.** If asked whether the store is available or whether you can save a secret,
call \`secret_list\` first and use its live \`status\` and \`capabilities\`; never infer availability
from a partial tool list. Save a new credential, or rotate one this host owns, with \`secret_store\`.
Retire a credential this host owns with \`secret_delete\`. A capability question is read-only:
never create, rotate, or delete anything without explicit user intent and the required value.

**Handling one.** Pass the value straight into the command or request that needs it, then drop it.
Never write a secret value into your reply, a commit, a log, or any file. Never copy one into
\`shared_memory_*\`, \`project_memory_*\`, or \`memory_*\`. Refer to secrets by slug, never by value.`,
    'mcp',
  );
}

function stripManagedContent(body: string): { body: string; changed: boolean } {
  let stripped = body.replace(OWN_BLOCK, '');
  stripped = stripped.replace(LEGACY_BLOCK, '');
  for (const legacyMemoryBlock of LEGACY_MEMORY_BLOCKS) {
    stripped = stripped.split(legacyMemoryBlock).join('');
  }
  return { body: stripped, changed: stripped !== body };
}

/**
 * Render enabled feature guidance in fixed provider order: Skills, Memory,
 * Projects, BrowserOS, Secrets. The returned managed digest covers the exact
 * delimited block appended to the body, including its final newline.
 */
export function renderManagedAgentFeatures(
  baseBody: string,
  context: ManagedAgentFeatureContext,
): RenderManagedAgentFeaturesResult {
  const skills = skillsSection(context);
  const memory = memorySection(context);
  const projects = projectsSection(context);
  const browseros = browserOsSection(context);
  const secrets = secretsSection(context);

  const skillsMetadata = skills?.metadata ?? absent(context.skills);
  const memoryMetadata = memory?.metadata ?? absent(context.memory);
  const projectsMetadata = projects?.metadata ?? absent(context.projects);
  const browserOsState =
    context.engine === ENGINE_CODEX
      ? context.browseros
      : { ...context.browseros, enabled: false, reason: 'unsupported_engine' };
  const browserOsMetadata = browseros?.metadata ?? absent(browserOsState);
  const sections: ManagedAgentFeatureSections = {
    skills: skillsMetadata,
    memories: memoryMetadata,
    memory_routing: memoryMetadata,
    projects: projectsMetadata,
    browseros: browserOsMetadata,
    secrets: secrets?.metadata ?? absent(context.secrets),
  };

  // Appended last on purpose: provider order is part of `managed_sha256`, so
  // inserting anywhere else would churn every host's document for four sections
  // that did not change.
  const renderedSections = [skills, memory, projects, browseros, secrets]
    .filter((section): section is RenderedSection => section !== null)
    .map((section) => section.text);
  const stripped = stripManagedContent(baseBody);

  if (renderedSections.length === 0) {
    if (!stripped.changed) return { body: baseBody, managed_sha256: null, sections };
    const cleaned = stripped.body.replace(/\s+$/, '');
    return {
      body: cleaned === '' ? '' : `${cleaned}\n`,
      managed_sha256: null,
      sections,
    };
  }

  const managedBlock = `${MANAGED_FEATURES_START}\n${renderedSections.join('\n\n')}\n${MANAGED_FEATURES_END}\n`;
  const cleaned = stripped.body.replace(/\s+$/, '');
  return {
    body: cleaned === '' ? managedBlock : `${cleaned}\n\n${managedBlock}`,
    managed_sha256: sha256(managedBlock),
    sections,
  };
}
