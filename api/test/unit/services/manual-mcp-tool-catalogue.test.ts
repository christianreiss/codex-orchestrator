import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpToolsRegistry, type ToolDeps } from '../../../src/services/mcp-tools.js';

/**
 * The `## Tool catalogue` section of `public/admin/manual/articles/mcp.md` is
 * the shipped, operator-facing copy of the claim `mcp-doc-catalog.test.ts`
 * already pins for `docs/MCP.md`: "these are the tools the registry
 * registers". It drifted — the whole `shared_memory_*` group was missing
 * while the article discussed those tools at length further down — because
 * nothing tied the list to `api/src/services/mcp-tools.ts`.
 *
 * This scan reads the catalogue bullets out of the article and the tool names
 * out of a registry built with every optional dependency wired, and fails on
 * any name in one and not the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTICLE = resolve(HERE, '../../../../public/admin/manual/articles/mcp.md');

/**
 * Names the article's catalogue deliberately does not line up with the
 * registry, keyed by tool name with the reason. Empty today: every registered
 * tool is documented and every documented tool is registered.
 */
const CATALOGUE_EXCEPTIONS: Record<string, string> = {};

/** The catalogue's bolded group headings, in article order. */
const GROUPS = [
  'Memory',
  'Shared memory',
  'Secrets',
  'Git Director',
  'Filesystem (operator only)',
  'Resources',
  'Skills',
  'Projects',
];

const SECTION = '## Tool catalogue';
/** A group heading: `**Label**`, with any capability note after (or inside) it. */
const GROUP_HEADING = /^\*\*(.+?)\*\*/;
/**
 * A catalogue bullet: comma-separated backticked names, then optional prose
 * after an em dash. Only that leading run counts, so the `MCP_FS_ROOT` and
 * `sharedMemories` spans in a bullet's note never read as tool names.
 */
const CATALOGUE_BULLET = /^- (`[a-z0-9_]+`(?:, `[a-z0-9_]+`)*)(?: —.*)?$/;
const NAME_SPAN = /`([a-z0-9_]+)`/g;

interface Group {
  /** The heading line, so the conditional-group claim can be checked. */
  heading: string;
  names: string[];
}

function collectCatalogue(): Map<string, Group> {
  const groups = new Map<string, Group>();
  let inCatalogue = false;
  let label = '';
  for (const line of readFileSync(ARTICLE, 'utf8').split('\n')) {
    if (line.startsWith('## ')) inCatalogue = line.trim() === SECTION;
    if (!inCatalogue) continue;
    const heading = GROUP_HEADING.exec(line);
    if (heading) {
      label = heading[1]!;
      groups.set(label, { heading: line, names: [] });
      continue;
    }
    const bullet = CATALOGUE_BULLET.exec(line);
    // A bullet before the first heading belongs to no group; the diffs below
    // catch it as an undocumented tool rather than throwing here.
    if (!bullet || !label) continue;
    groups.get(label)!.names.push(...[...bullet[1]!.matchAll(NAME_SPAN)].map((span) => span[1]!));
  }
  return groups;
}

/**
 * The catalogue is a list of names, so the registry only has to be built — no
 * handler runs. Empty stubs are enough to switch on every optional group.
 */
const ALL_DEPS = {
  memories: {},
  sharedMemories: {},
  projects: {},
  skills: {},
  resources: {},
  fs: {},
  secrets: {},
  gitDirector: {},
} as unknown as ToolDeps;

/** The same registry with the shared-memory service left out, as `ToolDeps` allows. */
const NO_SHARED_DEPS = { ...ALL_DEPS, sharedMemories: undefined } as ToolDeps;
/** Likewise without the secrets service. */
const NO_SECRETS_DEPS = { ...ALL_DEPS, secrets: undefined } as ToolDeps;
/** Likewise without the Git Director service. */
const NO_GIT_DIRECTOR_DEPS = { ...ALL_DEPS, gitDirector: undefined } as ToolDeps;

function registeredNames(deps: ToolDeps): string[] {
  // 'operator' sees the host tools too, so this is the whole registry.
  return new McpToolsRegistry(deps).list('operator').map((tool) => tool.name);
}

const catalogue = collectCatalogue();
const documented = [...catalogue.values()].flatMap((group) => group.names);
const registered = registeredNames(ALL_DEPS);

describe('manual mcp article tool catalogue', () => {
  it('extracts the catalogue it is meant to check', () => {
    // A scan that silently matched nothing would pass the diffs below.
    expect([...catalogue.keys()]).toEqual(GROUPS);
    expect(documented.length).toBeGreaterThan(40);
    expect(registered.length).toBeGreaterThan(40);
    expect(registered).toContain('memory_store');
    expect(registered).toContain('shared_memory_list');
    expect(registered).toContain('fs_search_in_files');
    // Each name is listed once, so a duplicate cannot mask a missing entry.
    expect([...new Set(documented)]).toEqual(documented);
    expect([...new Set(registered)]).toEqual(registered);
  });

  it('documents every registered tool', () => {
    const missing = registered.filter(
      (name) => !documented.includes(name) && !(name in CATALOGUE_EXCEPTIONS),
    );
    expect(
      missing,
      'add these to the matching group under "## Tool catalogue" in ' +
        'public/admin/manual/articles/mcp.md, or record them in CATALOGUE_EXCEPTIONS here with a reason',
    ).toEqual([]);
  });

  it('registers every documented tool', () => {
    const unregistered = documented.filter(
      (name) => !registered.includes(name) && !(name in CATALOGUE_EXCEPTIONS),
    );
    expect(
      unregistered,
      'these are listed in the article catalogue but no tool in api/src/services/mcp-tools.ts registers them',
    ).toEqual([]);
  });

  it('keeps the exception list free of stale entries', () => {
    const stale = Object.keys(CATALOGUE_EXCEPTIONS).filter(
      (name) => documented.includes(name) === registered.includes(name),
    );
    expect(stale, 'the article and the registry agree about these — drop them').toEqual([]);
    for (const reason of Object.values(CATALOGUE_EXCEPTIONS)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });

  it('flags the shared-memory group as conditional, the way the registry is', () => {
    expect(catalogue.get('Shared memory')!.heading).toContain(
      'only when the shared-memory service is wired',
    );
    expect(registeredNames(NO_SHARED_DEPS)).not.toContain('shared_memory_list');
  });

  it('flags the secrets group as conditional, the way the registry is', () => {
    expect(catalogue.get('Secrets')!.heading).toContain(
      'only when the secrets service is wired',
    );
    // Not merely blocked — absent. A registry built without the service must
    // not advertise a credential tool it cannot serve.
    for (const name of ['secret_list', 'secret_search', 'secret_get', 'secret_store', 'secret_delete']) {
      expect(registeredNames(NO_SECRETS_DEPS)).not.toContain(name);
    }
  });

  it('flags the Git Director group as conditional, the way the registry is', () => {
    expect(catalogue.get('Git Director')!.heading).toContain(
      'only when the Git Director service is wired',
    );
    // Absent, not merely refused: a registry built without the service must not
    // advertise an arbiter it has no way to consult.
    for (const name of ['git_register', 'git_list', 'git_join', 'git_merge_request', 'git_merge_status', 'git_release']) {
      expect(registeredNames(NO_GIT_DIRECTOR_DEPS)).not.toContain(name);
    }
  });
});
