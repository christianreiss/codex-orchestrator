import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `## Tools` section of `docs/MCP.md` is what operators and agents read to
 * decide which MCP tool to call. It drifted in both directions — it advertised
 * `memory_append`/`memory_query`/`memory_list`, which no registration has ever
 * created, and omitted registered tools (`memory_delete`, `skill_*`, the
 * `project_file_*` and `project_memory_*` sets) — because nothing tied it to
 * `api/src/services/mcp-tools.ts`.
 *
 * This scan reads the catalog bullets out of the doc and the `name:` values out
 * of the registry source, and fails on any name that appears in one and not the
 * other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DOC = resolve(HERE, '../../../../docs/MCP.md');
const REGISTRY = resolve(HERE, '../../../src/services/mcp-tools.ts');

/** The catalog bullets, in doc order. Each names one group's tools and nothing else. */
const GROUPS = [
  'Host-authenticated tools',
  'Fleet-wide shared memory',
  'Projects module enabled',
  'Fleet secrets store',
  'Operator/internal filesystem helpers',
];

/**
 * A catalog bullet: a group label, then backticked tool names to the end of the
 * line. Prose lives on the indented bullet under it, so a note mentioning
 * `next_offset` or `memory_*` never reads as a tool name.
 */
const CATALOG_LINE = /^- ([A-Za-z][A-Za-z /-]*): (`[a-zA-Z0-9_-]+`(?:, `[a-zA-Z0-9_-]+`)*)\.$/;
const NAME_SPAN = /`([a-zA-Z0-9_-]+)`/g;
/** `name: 'tool_name'` in a tool definition. `\b` keeps `stored_name:` out. */
const REGISTRATION = /\bname: '([a-zA-Z0-9_-]+)'/g;

/** Tool names per catalog bullet, keyed by group label. */
function collectDocGroups(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let inTools = false;
  for (const line of readFileSync(MCP_DOC, 'utf8').split('\n')) {
    if (line.startsWith('## ')) inTools = line.startsWith('## Tools');
    if (!inTools) continue;
    const bullet = CATALOG_LINE.exec(line);
    if (!bullet) continue;
    groups.set(
      bullet[1]!,
      [...bullet[2]!.matchAll(NAME_SPAN)].map((span) => span[1]!),
    );
  }
  return groups;
}

function collectRegisteredTools(): string[] {
  return [...readFileSync(REGISTRY, 'utf8').matchAll(REGISTRATION)].map((match) => match[1]!);
}

const docGroups = collectDocGroups();
const documented = [...docGroups.values()].flat();
const registered = collectRegisteredTools();

describe('docs/MCP.md tool catalog', () => {
  it('extracts the catalog it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertions below.
    expect([...docGroups.keys()]).toEqual(GROUPS);
    expect(documented.length).toBeGreaterThan(40);
    expect(registered.length).toBeGreaterThan(40);
    expect(registered).toContain('memory_store');
    expect(registered).toContain('fs_search_in_files');
    // Each name is listed once, so a duplicate cannot mask a missing entry.
    expect([...new Set(documented)]).toEqual(documented);
    expect([...new Set(registered)]).toEqual(registered);
  });

  it('documents every registered tool', () => {
    const missing = registered.filter((name) => !documented.includes(name));
    expect(missing, 'add these to the matching group bullet in docs/MCP.md').toEqual([]);
  });

  it('registers every documented tool', () => {
    const unregistered = documented.filter((name) => !registered.includes(name));
    expect(
      unregistered,
      'these are documented in docs/MCP.md but no tool in api/src/services/mcp-tools.ts registers them',
    ).toEqual([]);
  });
});
