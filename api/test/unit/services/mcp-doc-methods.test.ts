import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `## JSON-RPC methods` section of `docs/MCP.md` is the dispatch table an
 * agent reads before speaking to `POST /mcp`. Both of its neighbours are pinned
 * by a scan (`mcp-doc-catalog.test.ts` for the tool catalog,
 * `mcp-doc-templates.test.ts` for the resource templates); the method list was
 * tied to nothing and drifted, omitting `prompts/list`/`prompts.list` — the case
 * whose empty prompt list is what makes a client's prompts capability probe
 * succeed — and `prompts/get`/`prompts.get`, which answers -32601 on purpose.
 *
 * This scan reads the method spellings out of the dispatch bullets and the
 * `case` labels out of the `switch (method)` in the server, and fails on any
 * spelling that appears in one and not the other.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DOC = resolve(HERE, '../../../../docs/MCP.md');
const SERVER = resolve(HERE, '../../../src/services/mcp-server.ts');

/**
 * Dispatched spellings deliberately left undocumented, keyed by method with the
 * reason. Empty today — every case of the switch is on a bullet. An entry
 * belongs here only for a spelling clients must not be told about, e.g. one kept
 * alive for a single legacy caller.
 */
const ALLOWED: Record<string, string> = {};

/** The dispatch bullets, in doc order. Each names one group's methods and nothing else. */
const GROUPS = ['Core', 'Tools', 'Resources', 'Prompts'];

const METHOD = '[a-z][a-zA-Z0-9_./]*';
/** One documented method: a canonical spelling, then its aliases in parentheses. */
const ENTRY = `\`${METHOD}\`(?: \\(\`${METHOD}\`(?:, \`${METHOD}\`)*\\))?`;
/**
 * A dispatch bullet: a group label, then entries to the end of the line. Prose
 * lives on the indented bullet under it, so a note mentioning `prompts/get`
 * never reads as a documented spelling.
 */
const DISPATCH_LINE = new RegExp(`^- ([A-Za-z][A-Za-z /-]*): (${ENTRY}(?:, ${ENTRY})*)\\.$`);
const NAME_SPAN = new RegExp(`\`(${METHOD})\``, 'g');
/** A `case` label of the dispatch switch. */
const CASE_LABEL = /case '([^']+)':/g;

/** Method spellings per dispatch bullet, keyed by group label. */
function collectDocGroups(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let inMethods = false;
  for (const line of readFileSync(MCP_DOC, 'utf8').split('\n')) {
    if (line.startsWith('## ')) inMethods = line.startsWith('## JSON-RPC methods');
    if (!inMethods) continue;
    const bullet = DISPATCH_LINE.exec(line);
    if (!bullet) continue;
    groups.set(
      bullet[1]!,
      [...bullet[2]!.matchAll(NAME_SPAN)].map((span) => span[1]!),
    );
  }
  return groups;
}

/** The labelled cases of `switch (method)`, in source order. The default arm ends it. */
function collectDispatched(): string[] {
  const source = readFileSync(SERVER, 'utf8');
  const open = source.indexOf('switch (method) {');
  if (open < 0) throw new Error(`${SERVER} has no switch (method) statement`);
  const end = source.indexOf('default:', open);
  if (end < 0) throw new Error(`the switch (method) in ${SERVER} has no default arm`);
  return [...source.slice(open, end).matchAll(CASE_LABEL)].map((label) => label[1]!);
}

const docGroups = collectDocGroups();
const documented = [...docGroups.values()].flat();
const dispatched = collectDispatched();

describe('docs/MCP.md JSON-RPC methods', () => {
  it('extracts the dispatch table it is meant to check', () => {
    // A scan that silently matched nothing would pass the assertions below.
    expect([...docGroups.keys()]).toEqual(GROUPS);
    expect(documented.length).toBeGreaterThan(25);
    expect(dispatched.length).toBeGreaterThan(25);
    expect(dispatched).toContain('initialize');
    expect(dispatched).toContain('prompts/get');
    // Each spelling is listed once, so a duplicate cannot mask a missing entry.
    expect([...new Set(documented)]).toEqual(documented);
    expect([...new Set(dispatched)]).toEqual(dispatched);
  });

  it('documents every dispatched method', () => {
    const missing = dispatched.filter((method) => !documented.includes(method) && !(method in ALLOWED));
    expect(missing, 'add these to the matching group bullet in docs/MCP.md').toEqual([]);
  });

  it('dispatches every documented method', () => {
    const undispatched = documented.filter((method) => !dispatched.includes(method));
    expect(
      undispatched,
      'these are documented in docs/MCP.md but no case in api/src/services/mcp-server.ts dispatches them',
    ).toEqual([]);
  });
});
