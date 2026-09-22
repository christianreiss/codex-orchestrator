import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Closing the project tool schemas — `additionalProperties: false`, which
 * `validateAgainstSchema` has always supported and no project tool set — is what
 * turns a mistyped argument into an error instead of a silent no-op. It is also
 * the single most likely way to break a working caller, because the services
 * accept argument aliases that no schema ever declared: `project_create` reads
 * `agents_markdown`, `project_memory_search` reads `q`, every board handler
 * reads `engine`. Those calls worked precisely BECAUSE nothing validated.
 *
 * So this suite holds the two halves together: every alias a service reads must
 * be declared in the schema of the tool that routes to it, and every project
 * tool must be closed. Read as text, like the other registry guards, because
 * `buildEntries` needs a full set of service dependencies to call.
 */

const REGISTRY = resolve(import.meta.dirname, '../../../src/services/mcp-tools.ts');
const source = readFileSync(REGISTRY, 'utf8');

interface ToolSchema {
  name: string;
  body: string;
  properties: string[];
  closed: boolean;
}

function projectTools(): ToolSchema[] {
  const out: ToolSchema[] = [];
  const re = /name: '(project_[a-z_]+)',\n(.*?)\n\s*\},\n\s*(?:\/\/[^\n]*\n\s*)*handler:/gs;
  for (const match of source.matchAll(re)) {
    const body = match[2]!;
    out.push({
      name: match[1]!,
      body,
      properties: [...body.matchAll(/^\s+([a-z_]+): \{ type:/gm)].map((m) => m[1]!),
      closed: body.includes('additionalProperties: false'),
    });
  }
  return out;
}

const tools = projectTools();
const byName = new Map(tools.map((t) => [t.name, t]));

describe('project tool schemas', () => {
  it('finds the registry it is meant to check', () => {
    // A scan that matched nothing would pass every assertion below vacuously.
    expect(tools.length).toBeGreaterThan(25);
    expect(byName.has('project_summary')).toBe(true);
    expect(byName.has('project_card_claim')).toBe(true);
  });

  it('closes every one of them', () => {
    expect(tools.filter((t) => !t.closed).map((t) => t.name)).toEqual([]);
  });

  /**
   * Each entry is an alias a service reads off the argument object. Grep the
   * cited line before deleting one: removing it here does not remove it from the
   * service, it only stops callers being able to reach it.
   */
  const ALIASES: Array<[tool: string, alias: string, readAt: string]> = [
    ['project_create', 'project', 'host-projects.ts normalizeSlug(payload.slug ?? payload.project)'],
    ['project_create', 'agents_markdown', 'host-projects.ts createProject roster fallback'],
    ['project_file_upsert', 'name', 'host-projects.ts normalizeFilePayload stored_name fallback'],
    ['project_file_upsert', 'text', 'host-projects.ts normalizeFilePayload content fallback'],
    ['project_memory_upsert', 'id', 'host-projects.ts normalizeMemoryPayload key fallback'],
    ['project_memory_upsert', 'memory_id', 'host-projects.ts normalizeMemoryPayload key fallback'],
    ['project_memory_upsert', 'text', 'host-projects.ts normalizeMemoryPayload content fallback'],
    ['project_memory_search', 'q', 'host-projects.ts searchMemories query fallback'],
    ['project_changes', 'since_seq', 'mcp-tools.ts project_changes handler'],
  ];

  for (const [tool, alias, readAt] of ALIASES) {
    it(`declares ${tool}.${alias}, which the service still reads`, () => {
      const schema = byName.get(tool);
      expect(schema, `${tool} is not registered`).toBeDefined();
      expect(schema!.properties, `read at: ${readAt}`).toContain(alias);
    });
  }

  it('declares engine on every board tool, which all of them read', () => {
    const board = tools.filter((t) => /^project_(board|card)_/.test(t.name));
    expect(board.length).toBe(7);
    expect(board.filter((t) => !t.properties.includes('engine')).map((t) => t.name)).toEqual([]);
  });
});
