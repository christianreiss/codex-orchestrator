import { describe, it, expect } from 'vitest';
import { McpToolsRegistry, type ToolDeps } from '../../../src/services/mcp-tools.js';
import {
  managedCocoManifest,
  managedCocoBootstrapGuidance,
} from '../../../src/services/managed-coco-skill.js';
import { renderManagedAgentFeatures } from '../../../src/services/managed-agents-features.js';
import { managedContextManifest } from '../../../src/services/managed-context-skill.js';
import { managedSkillManagerManifest } from '../../../src/services/managed-skill-manager.js';
import { MCP_TOOL_NAMES } from '../../../src/services/shared-memory-tool-names.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../src/util/engine.js';

/**
 * `docs/MCP.md` and the manual article are pinned against the registry, but the
 * text agents actually act on is not those: it is the CoCo skill manifest, the
 * CoCo bootstrap guidance, the managed AGENTS/CLAUDE memory block and the
 * `#context` manifest, all of which name tools as free prose and all of which
 * ship to every host. A rename in `api/src/services/mcp-tools.ts` leaves the
 * fleet instructed to call tools that no longer exist, and nothing fails —
 * agents just quietly stop using the store.
 *
 * This scan pulls every snake_case identifier out of that shipped content and
 * requires each one to be a tool the registry registers, `foo_*` family
 * spellings included.
 */

/**
 * The registry only has to be built to be listed, so empty stubs are enough to
 * switch on every optional group. Same shape as `manual-mcp-tool-catalogue.test.ts`.
 */
const ALL_DEPS = {
  memories: {},
  sharedMemories: {},
  projects: {},
  skills: {},
  resources: {},
  fs: {},
  secrets: {},
} as unknown as ToolDeps;

// 'operator' sees the host tools too, so this is the whole registry.
const registered = new McpToolsRegistry(ALL_DEPS).list('operator').map((tool) => tool.name);

/**
 * Snake_case identifiers, which is how these documents spell tool names —
 * mostly unbackticked, so the whole text is scanned rather than code spans.
 * At least one underscore is required, which is what keeps `memory://`,
 * `context/` and the `~/.claude/.../memory/` paths out of the results, and a
 * trailing `_*` is kept so family spellings can be checked as families.
 */
const IDENTIFIER = /[a-z][a-z0-9]*(?:_(?:[a-z0-9]+|\*))+/g;

/**
 * Identifiers in this content that are deliberately not tool names, with the
 * reason each one is there. Anything not listed here has to be a live tool.
 */
const NON_TOOL_TOKENS: Record<string, string> = {
  stored_name: 'the file key in project:// resource URIs and the project_file_* argument, not a tool',
  next_offset: 'a shared_memory_read response field the manifest tells agents to follow',
  latest_seq: 'a project_bootstrap/project_changes response field, not a tool',
  expected_sha256: 'the optimistic-concurrency argument of shared_memory_write, not a tool',
  display_name: 'optional skill_store display metadata, not a tool',
};

interface Mention {
  /** File plus the function that produced the text, so a failure names the source. */
  source: string;
  name: string;
}

const guidance = managedCocoBootstrapGuidance();
const enabled = { enabled: true, reason: 'ok' };

const CONTENT: Array<{ source: string; text: string }> = [
  { source: 'api/src/services/managed-coco-skill.ts managedCocoManifest()', text: managedCocoManifest() },
  {
    source: 'api/src/services/managed-coco-skill.ts managedCocoBootstrapGuidance().instructions',
    text: guidance.instructions,
  },
  ...guidance.quickstart.map((line, i) => ({
    source: `api/src/services/managed-coco-skill.ts managedCocoBootstrapGuidance().quickstart[${i}]`,
    text: line,
  })),
  ...[ENGINE_CODEX, ENGINE_CLAUDE].map((engine) => ({
    source: `api/src/services/managed-agents-features.ts renderManagedAgentFeatures('${engine}')`,
    text: renderManagedAgentFeatures('', {
      engine,
      skills: { ...enabled, count: 1 },
      memory: enabled,
      projects: enabled,
      browseros: enabled,
      secrets: { ...enabled, count: 1 },
    }).body,
  })),
  {
    source: 'api/src/services/managed-context-skill.ts managedContextManifest()',
    text: managedContextManifest(),
  },
  {
    source: 'api/src/services/managed-skill-manager.ts managedSkillManagerManifest()',
    text: managedSkillManagerManifest(),
  },
];

const mentions: Mention[] = CONTENT.flatMap(({ source, text }) =>
  [...new Set([...text.matchAll(IDENTIFIER)].map((match) => match[0]))].map((name) => ({ source, name })),
);

/** A `foo_*` family is live when the registry has at least one tool with that prefix. */
function isLive(name: string): boolean {
  if (name.endsWith('_*')) {
    const prefix = name.slice(0, -1);
    return registered.some((tool) => tool.startsWith(prefix));
  }
  return registered.includes(name);
}

const named = (mention: Mention): string => `${mention.source}: ${mention.name}`;

describe('mcp tool names in managed agent-facing content', () => {
  it('extracts the identifiers it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertion below.
    expect(registered.length).toBeGreaterThan(40);
    expect(mentions.length).toBeGreaterThan(40);
    for (const { source } of CONTENT) {
      expect(mentions.filter((mention) => mention.source === source).length).toBeGreaterThan(0);
    }
    const found = new Set(mentions.map((mention) => mention.name));
    expect(found).toContain('project_bootstrap');
    expect(found).toContain('project_memory_upsert');
    expect(found).toContain('shared_memory_append');
    expect(found).toContain('shared_memory_*');
    expect(found).toContain('memory_*');
  });

  it('names only tools the registry registers', () => {
    const dead = mentions.filter(
      (mention) => !(mention.name in NON_TOOL_TOKENS) && !isLive(mention.name),
    );
    expect(
      dead.map(named),
      'this shipped content tells every host to call these, but no tool in ' +
        'api/src/services/mcp-tools.ts registers them — rename the content with the tool, or ' +
        'record the identifier in NON_TOOL_TOKENS here with a reason',
    ).toEqual([]);
  });

  it('keeps every MCP_TOOL_NAMES value pointing at a registered tool', () => {
    const dead = Object.entries(MCP_TOOL_NAMES).filter(([, name]) => !registered.includes(name));
    expect(
      dead.map(([key, name]) => `${key}: ${name}`),
      'api/src/services/shared-memory-tool-names.ts names tools the registry does not register',
    ).toEqual([]);
  });

  it('keeps the non-tool allowlist honest', () => {
    for (const [token, reason] of Object.entries(NON_TOOL_TOKENS)) {
      expect(mentions.some((mention) => mention.name === token), `${token} is no longer mentioned — drop it`).toBe(true);
      expect(isLive(token), `${token} is a registered tool now — drop it`).toBe(false);
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
