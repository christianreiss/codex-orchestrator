/**
 * `#coco` is derived from code and shipped fleet-wide, so the manifest is the
 * only instruction most agents ever read about the project tools. If a tool is
 * renamed in `mcp-tools.ts` or a `project://` form changes in
 * `mcp-resources.ts`, nothing else notices: the skill keeps telling every host
 * to call a name the server no longer registers and the whole gate stays green.
 * These assertions are what notices — same guard `#context` already carries.
 */
import { describe, it, expect } from 'vitest';
import { versions as versionsTable } from '../../../src/db/schema.js';
import {
  MANAGED_COCO_SKILL_SLUG,
  PROJECTS_ENABLED_FLAG,
  buildManagedCocoSkill,
  getManagedCocoSkillIfEnabled,
  isManagedCocoSlug,
  managedCocoBootstrapGuidance,
  managedCocoManifest,
} from '../../../src/services/managed-coco-skill.js';
import { McpResourcesService } from '../../../src/services/mcp-resources.js';
import { McpToolsRegistry } from '../../../src/services/mcp-tools.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { McpFsTools } from '../../../src/services/mcp-fs.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { SharedMemoriesService } from '../../../src/services/shared-memories.js';
import type { ProjectBoardService } from '../../../src/services/project-board.js';

/**
 * Tool handlers are lazy closures, so registration only cares that a dep is
 * present — empty stubs are enough to get every optional surface registered.
 */
const deps = {
  memories: {} as unknown as McpMemoriesService,
  sharedMemories: {} as unknown as SharedMemoriesService,
  projects: {} as unknown as HostProjectsService,
  skills: {} as unknown as HostSkillsService,
};
const resources = new McpResourcesService(deps);
const registry = new McpToolsRegistry({
  ...deps,
  resources,
  fs: {} as unknown as McpFsTools,
  // The skill tells agents to call the board first, so the board surface has to
  // be present for that instruction to be checkable at all.
  board: {} as unknown as ProjectBoardService,
});

/** Host capability: that is who reads #coco and calls its tools. */
const registeredTools = registry.list().map((t) => t.name);
const registeredTemplates = resources.listTemplates().map((t) => String(t['uriTemplate']));

/** Deliberate exceptions — names #coco may mention that the server does not register. */
const ALLOWED_UNREGISTERED: string[] = [];

const TOOL_TOKEN_RE = /\b(?:project|shared_memory|memory)_[a-z0-9_]*\*?/g;
const PROJECT_URI_RE = /project:\/\/\{[^\s,.;]*/g;

const guidance = managedCocoBootstrapGuidance();
const cocoTexts: Array<{ label: string; text: string }> = [
  { label: 'manifest', text: managedCocoManifest() },
  { label: 'bootstrap guidance', text: [guidance.instructions, ...guidance.quickstart].join('\n') },
];

function tokensIn(text: string, re: RegExp): string[] {
  return [...new Set(text.match(re) ?? [])].sort();
}

/** `project_todo_*` and friends resolve when any registered tool carries the prefix. */
function resolvesToTool(token: string): boolean {
  if (ALLOWED_UNREGISTERED.includes(token)) return true;
  if (token.endsWith('*')) {
    const prefix = token.slice(0, -1);
    return registeredTools.some((name) => name.startsWith(prefix));
  }
  return registeredTools.includes(token);
}

describe('managed #coco skill names only real MCP surfaces', () => {
  for (const { label, text } of cocoTexts) {
    it(`names only registered tools in the ${label}`, () => {
      const tokens = tokensIn(text, TOOL_TOKEN_RE);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.filter((token) => !resolvesToTool(token))).toEqual([]);
    });

    it(`names only registered project:// templates in the ${label}`, () => {
      const uris = tokensIn(text, PROJECT_URI_RE);
      expect(uris.filter((uri) => !registeredTemplates.includes(uri) && !ALLOWED_UNREGISTERED.includes(uri))).toEqual([]);
    });
  }

  // A guard that extracts nothing passes vacuously, so pin the surfaces the
  // skill exists to advertise.
  it('still names the coordination tools and all three project:// forms', () => {
    const manifest = managedCocoManifest();
    expect(manifest).toContain('project_bootstrap');
    expect(manifest).toContain('project_note_upsert');
    expect(manifest).toContain('shared_memory_append');
    expect(tokensIn(manifest, PROJECT_URI_RE)).toEqual([
      'project://{slug}',
      'project://{slug}/files/{stored_name}',
      'project://{slug}/memory/{key}',
    ]);
  });

  it('requires a stable full-document read before replacing shared memory', () => {
    const manifest = managedCocoManifest();
    expect(manifest).toMatch(/complete body from offset 0 through every next_offset/i);
    expect(manifest).toMatch(/one stable memory\.sha256/i);
    expect(manifest).toMatch(/resource_create\/resource_update on shared:\/\//i);
    expect(manifest).toMatch(/never replace from an excerpt, preview, chunk, or partial read/i);
    expect(manifest).toMatch(/shared_memory_delete or resource_delete on shared:\/\/ only when the whole record is invalid or superseded/i);

    const bootstrap = [guidance.instructions, ...guidance.quickstart].join('\n');
    expect(bootstrap).toMatch(/complete body from offset 0 through every next_offset/i);
    expect(bootstrap).toMatch(/one stable memory\.sha256/i);
    expect(bootstrap).toMatch(/resource_create\/resource_update on shared:\/\//i);
  });
});

describe('buildManagedCocoSkill', () => {
  it('derives a stable sha from the manifest text', () => {
    const a = buildManagedCocoSkill('t');
    const b = buildManagedCocoSkill('t');
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.managed).toBe(true);
    expect(a.uri).toBe('skill://coco');
    expect(a.canonical_uri).toBe(a.uri);
    expect(a.slug).toBe(MANAGED_COCO_SKILL_SLUG);
  });

  it('carries valid frontmatter with the slug as name', () => {
    const manifest = managedCocoManifest();
    expect(manifest.startsWith('---\n')).toBe(true);
    expect(manifest).toContain(`name: ${MANAGED_COCO_SKILL_SLUG}`);
    expect(manifest).toMatch(/^description: "/m);
  });
});

describe('getManagedCocoSkillIfEnabled', () => {
  function makeDb(rows?: Array<Record<string, unknown>>): DbFake {
    const db = createDbFake();
    if (rows) db.tables.set(versionsTable, rows);
    return db;
  }

  it('serves nothing while the Projects flag is off, missing, or unwritten', async () => {
    // Flag row absent entirely, present but off, and the whole table unseeded.
    expect(await getManagedCocoSkillIfEnabled(makeDb([{ name: 'schema_version', version: '7', updatedAt: 't' }]) as never)).toBeNull();
    expect(await getManagedCocoSkillIfEnabled(makeDb([{ name: PROJECTS_ENABLED_FLAG, version: '0', updatedAt: 't' }]) as never)).toBeNull();
    expect(await getManagedCocoSkillIfEnabled(makeDb() as never)).toBeNull();
  });

  it('serves the skill carrying the flag row’s updatedAt when Projects is on', async () => {
    const db = makeDb([{ name: PROJECTS_ENABLED_FLAG, version: '1', updatedAt: '2026-07-28T09:30:00Z' }]);
    const skill = await getManagedCocoSkillIfEnabled(db as never);
    expect(skill).not.toBeNull();
    expect(skill!.updated_at).toBe('2026-07-28T09:30:00Z');
    expect(skill!.manifest).toBe(managedCocoManifest());
    expect(skill!.sha256).toBe(buildManagedCocoSkill('2026-07-28T09:30:00Z').sha256);
  });
});

describe('isManagedCocoSlug', () => {
  it('trims and case-folds without matching neighbours', () => {
    expect(isManagedCocoSlug('coco')).toBe(true);
    expect(isManagedCocoSlug('CoCo')).toBe(true);
    expect(isManagedCocoSlug('  coco\n')).toBe(true);
    expect(isManagedCocoSlug('cocos')).toBe(false);
    expect(isManagedCocoSlug('co co')).toBe(false);
    expect(isManagedCocoSlug('')).toBe(false);
  });
});
