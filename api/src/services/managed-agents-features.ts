/**
 * Pure, deterministic renderer for the feature guidance appended to served
 * AGENTS.md / CLAUDE.md documents. Capability discovery stays in
 * HostAgentsService; this module only turns resolved feature gates into text
 * and diagnostics.
 */
import { createHash } from 'node:crypto';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../util/engine.js';
import { buildManagedMemoryBlock, MANAGED_MEMORY_HEADING } from './managed-agents-memory.js';

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
const LEGACY_MEMORY_BLOCKS = [...new Set(
  [ENGINE_CODEX, ENGINE_CLAUDE].flatMap((engine) => {
    const block = buildManagedMemoryBlock(engine);
    return [block, block.replace(/\n$/, '')];
  }),
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
\`project_bootstrap\` for the active project.`,
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
 * Projects, BrowserOS. The returned managed digest covers the exact delimited
 * block appended to the body, including its final newline.
 */
export function renderManagedAgentFeatures(
  baseBody: string,
  context: ManagedAgentFeatureContext,
): RenderManagedAgentFeaturesResult {
  const skills = skillsSection(context);
  const memory = memorySection(context);
  const projects = projectsSection(context);
  const browseros = browserOsSection(context);

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
  };

  const renderedSections = [skills, memory, projects, browseros]
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
