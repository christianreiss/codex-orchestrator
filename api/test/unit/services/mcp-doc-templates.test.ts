import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpResourcesService } from '../../../src/services/mcp-resources.js';
import type { McpMemoriesService } from '../../../src/services/mcp-memories.js';
import type { HostProjectsService } from '../../../src/services/host-projects.js';
import type { HostSkillsService } from '../../../src/services/host-skills.js';
import type { SharedMemoriesService } from '../../../src/services/shared-memories.js';

/**
 * The resource-template bullet in `docs/MCP.md` is the other half of the doc
 * guarded by `mcp-doc-catalog.test.ts`, and it drifted the same way: it
 * advertised `memory_by_id`, `memory_store`, `skill_manifest` and
 * `project_bootstrap` — names no template registers — while omitting the
 * `project_file` and `project_memory` templates that do.
 *
 * This scan reads the name/URI pairs out of the bullet and compares them with
 * what `McpResourcesService.listTemplates()` returns, and fails on any pair
 * that appears on one side and not the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DOC = resolve(HERE, '../../../../docs/MCP.md');

/** The one bullet that lists the templates; prose lives on the sub-bullet under it. */
const BULLET_PREFIX = '- `resources/templates/list` exposes templates ';
/** A documented template: a backticked name followed by its backticked URI template. */
const PAIR = /`([a-zA-Z0-9_-]+)` \(`([a-z]+:\/\/[^`]+)`\)/g;

/** `name uriTemplate`, the comparable form of one template. */
function pairKey(name: string, uriTemplate: string): string {
  return `${name} ${uriTemplate}`;
}

function collectDocumented(): string[] {
  const bullet = readFileSync(MCP_DOC, 'utf8')
    .split('\n')
    .find((line) => line.startsWith(BULLET_PREFIX));
  if (!bullet) throw new Error(`docs/MCP.md has no bullet starting with "${BULLET_PREFIX}"`);
  return [...bullet.matchAll(PAIR)].map((pair) => pairKey(pair[1]!, pair[2]!));
}

const stub = <T,>(): T => ({}) as unknown as T;

function collectRegistered(withShared: boolean): string[] {
  const service = new McpResourcesService({
    memories: stub<McpMemoriesService>(),
    projects: stub<HostProjectsService>(),
    skills: stub<HostSkillsService>(),
    ...(withShared ? { sharedMemories: stub<SharedMemoriesService>() } : {}),
  });
  return service
    .listTemplates()
    .map((template) => pairKey(String(template['name']), String(template['uriTemplate'])));
}

const documented = collectDocumented();
const registered = collectRegistered(true);

describe('docs/MCP.md resource templates', () => {
  it('extracts the bullet it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertions below.
    expect(documented.length).toBeGreaterThan(4);
    expect(registered.length).toBeGreaterThan(4);
    expect(registered).toContain('shared_memory shared://{slug}');
    // Each pair is listed once, so a duplicate cannot mask a missing entry.
    expect([...new Set(documented)]).toEqual(documented);
    expect([...new Set(registered)]).toEqual(registered);
  });

  it('documents every registered template', () => {
    const missing = registered.filter((pair) => !documented.includes(pair));
    expect(missing, 'add these to the resource-template bullet in docs/MCP.md').toEqual([]);
  });

  it('registers every documented template', () => {
    const unregistered = documented.filter((pair) => !registered.includes(pair));
    expect(
      unregistered,
      'these are documented in docs/MCP.md but McpResourcesService.listTemplates() returns no such name/URI template',
    ).toEqual([]);
  });

  it('documents shared_memory as the only conditional template', () => {
    const withoutShared = collectRegistered(false);
    expect(registered.filter((pair) => !withoutShared.includes(pair))).toEqual([
      'shared_memory shared://{slug}',
    ]);
  });
});
