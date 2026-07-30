import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_FEATURES_END,
  MANAGED_FEATURES_START,
  renderManagedAgentFeatures,
  type ManagedAgentFeatureContext,
  type ManagedFeatureState,
} from '../../../src/services/managed-agents-features.js';
import { buildManagedMemoryBlock } from '../../../src/services/managed-agents-memory.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../../src/util/engine.js';

const enabled = (count?: number): ManagedFeatureState => ({
  enabled: true,
  reason: 'ok',
  ...(count === undefined ? {} : { count }),
});
const disabled = (reason: string, count?: number): ManagedFeatureState => ({
  enabled: false,
  reason,
  ...(count === undefined ? {} : { count }),
});

function context(
  engine: Engine,
  overrides: Partial<ManagedAgentFeatureContext> = {},
): ManagedAgentFeatureContext {
  return {
    engine,
    skills: disabled('no_skills', 0),
    memory: disabled('mcp_disabled'),
    projects: disabled('projects_disabled'),
    browseros: disabled(engine === ENGINE_CODEX ? 'host_disabled' : 'unsupported_engine'),
    ...overrides,
  };
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('renderManagedAgentFeatures', () => {
  it('renders providers in deterministic order with exact block and section digests', () => {
    const out = renderManagedAgentFeatures(
      '# Fleet rules\n',
      context(ENGINE_CODEX, {
        skills: enabled(7),
        memory: enabled(),
        projects: enabled(),
        browseros: enabled(),
      }),
    );

    expect(out.body).toContain(MANAGED_FEATURES_START);
    expect(out.body).toContain(MANAGED_FEATURES_END);
    const positions = ['## Skills', '## Memory', '## Projects / CoCo', '## BrowserOS'].map((heading) =>
      out.body.indexOf(heading),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((position) => position >= 0)).toBe(true);

    const managed = out.body.slice(out.body.indexOf(MANAGED_FEATURES_START));
    expect(out.managed_sha256).toBe(sha256(managed));
    expect(out.sections.skills).toMatchObject({
      present: true,
      reason: 'ok',
      count: 7,
      transport: 'mcp',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(out.sections.memories).toBe(out.sections.memory_routing);
    expect(out.sections.projects.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.sections.browseros.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses MCP skill discovery for Codex', () => {
    const out = renderManagedAgentFeatures('', context(ENGINE_CODEX, { skills: enabled(3) }));

    expect(out.body).toContain('skill_list');
    expect(out.body).toContain('skill_retrieve');
    expect(out.body).toContain('resource_read');
    expect(out.body).toContain('skill://{slug}');
    expect(out.body).not.toContain('~/.claude/skills');
    expect(out.sections.skills.transport).toBe('mcp');
  });

  it('uses native Skill wording for Claude and never advertises BrowserOS there', () => {
    const out = renderManagedAgentFeatures(
      '',
      context(ENGINE_CLAUDE, {
        skills: enabled(4),
        browseros: enabled(),
      }),
    );

    expect(out.body).toContain('~/.claude/skills/<slug>/SKILL.md');
    expect(out.body).not.toContain('skill_list');
    expect(out.body).not.toContain('skill_retrieve');
    expect(out.body).not.toContain('BrowserOS');
    expect(out.sections.skills.transport).toBe('native');
    expect(out.sections.browseros).toEqual({ present: false, reason: 'unsupported_engine' });
  });

  it('preserves established MCP memory routing and engine-local overrides', () => {
    const codex = renderManagedAgentFeatures('', context(ENGINE_CODEX, { memory: enabled() }));
    const claude = renderManagedAgentFeatures('', context(ENGINE_CLAUDE, { memory: enabled() }));

    for (const out of [codex, claude]) {
      expect(out.body).toContain('shared_memory_list');
      expect(out.body).toContain('shared_memory_search');
      expect(out.body).toContain('shared_memory_read');
      expect(out.body).toContain('shared_memory_write');
      expect(out.body).toContain('shared_memory_append');
      expect(out.body).toContain('project_memory_*');
      expect(out.body).toContain('memory_*');
      expect(out.body).toMatch(/before searching the filesystem/i);
      expect(out.body).toMatch(/never store secrets/i);
    }
    expect(codex.body).toContain("Codex's own local memories feature");
    expect(codex.body).not.toContain('~/.claude/projects');
    expect(claude.body).toContain('~/.claude/projects/**/memory/*.md');
    expect(claude.body).toContain('MEMORY.md');
  });

  it('reports disabled providers without emitting a managed block', () => {
    const base = '# Untouched\n\nKeep this trailing whitespace.  \n';
    const out = renderManagedAgentFeatures(base, context(ENGINE_CODEX));

    expect(out.body).toBe(base);
    expect(out.managed_sha256).toBeNull();
    expect(out.sections).toMatchObject({
      skills: { present: false, reason: 'no_skills', count: 0 },
      memories: { present: false, reason: 'mcp_disabled' },
      memory_routing: { present: false, reason: 'mcp_disabled' },
      projects: { present: false, reason: 'projects_disabled' },
      browseros: { present: false, reason: 'host_disabled' },
    });
  });

  it('replaces its own block idempotently instead of duplicating it', () => {
    const first = renderManagedAgentFeatures(
      '# Base\n',
      context(ENGINE_CODEX, {
        skills: enabled(1),
        memory: enabled(),
      }),
    );
    const second = renderManagedAgentFeatures(
      first.body,
      context(ENGINE_CODEX, {
        skills: enabled(1),
        memory: enabled(),
      }),
    );

    expect(second).toEqual(first);
    expect(second.body.split(MANAGED_FEATURES_START)).toHaveLength(2);
    expect(second.body.split(MANAGED_FEATURES_END)).toHaveLength(2);
  });

  it('removes legacy cdx/clx Skills and Memories blocks before rendering', () => {
    const legacy = `# Base

<!-- cdx:skills:start -->
## Old Skills
stale
<!-- cdx:skills:end -->

<!-- clx:memories:start -->
## Old Memories
stale
<!-- clx:memories:end -->
`;
    const out = renderManagedAgentFeatures(legacy, context(ENGINE_CODEX, { skills: enabled(2) }));

    expect(out.body).not.toContain('cdx:skills');
    expect(out.body).not.toContain('clx:memories');
    expect(out.body).not.toContain('stale');
    expect(out.body.split('## Skills')).toHaveLength(2);
  });

  it('replaces the former trailing unmarked Memory block', () => {
    const legacy = `# Base\n\n${buildManagedMemoryBlock(ENGINE_CODEX)}`;
    const out = renderManagedAgentFeatures(legacy, context(ENGINE_CODEX, { memory: enabled() }));

    expect(out.body).not.toContain('## Memory (managed)');
    expect(out.body.split('## Memory')).toHaveLength(2);
  });

  it('preserves operator rules appended below an exact former Memory block', () => {
    const base = `# Base\n\n${buildManagedMemoryBlock(ENGINE_CODEX)}\n## Operator rules\n\nKeep this rule.\n`;

    const out = renderManagedAgentFeatures(base, context(ENGINE_CODEX, { memory: enabled() }));

    expect(out.body).toContain('## Operator rules');
    expect(out.body).toContain('Keep this rule.');
    expect(out.body).not.toContain('## Memory (managed)');
    expect(out.body.split('## Memory')).toHaveLength(2);
  });

  it('strips stale managed content when every provider becomes disabled', () => {
    const enabledBody = renderManagedAgentFeatures(
      '# Base\n',
      context(ENGINE_CODEX, {
        skills: enabled(1),
      }),
    ).body;
    const out = renderManagedAgentFeatures(enabledBody, context(ENGINE_CODEX));

    expect(out.body).toBe('# Base\n');
    expect(out.managed_sha256).toBeNull();
    expect(out.body).not.toContain('managed-features');
  });
});
