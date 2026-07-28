import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inComment, matchingBracket, sourceFiles, STRING_LITERAL } from './registered-routes.js';

/**
 * `DEFAULT_INVALIDATIONS` in `frontend/src/lib/ws/events.ts` routes WS events to
 * svelte-query keys, and `event-invalidation-coverage.test.ts` holds it to the
 * events the API publishes — but nothing held the other end. A mapped key no
 * query uses invalidates nothing, so the push arrives and the screen stays
 * stale, with every suite green: `api-key.changed` invalidated `["api-keys"]`
 * long after the API-key views moved to `["keys", …]`.
 *
 * This scan compares the root segment of every mapped key against the root of
 * every query key the admin UI uses — `queryKey: [...]` literals and the
 * `[...] as const` key factories they are built from. Roots only: svelte-query
 * matches invalidations by prefix, so `["logs", "api"]` legitimately refreshes
 * any `["logs", …]` query, and only a dead root means a dead entry.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = resolve(HERE, '../../../../frontend/src');
/** The map under test, relative to `frontend/src`. */
const EVENTS_FILE = 'lib/ws/events.ts';

/** Mapped key roots that deliberately match no query, and why. */
const UNUSED_QUERY_ROOTS: Record<string, string> = {};

interface MappedKey {
  /** WS event type the key is mapped to. */
  event: string;
  /** First segment of the query key. */
  root: string;
  line: number;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Blank out whole-line comments, keeping every other character at its offset. */
function blankComments(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}

/** Top-level comma-separated pieces of a bracket body. */
function elements(body: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      pieces.push(body.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(body.slice(start));
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '');
}

const frontendSources: [file: string, source: string][] = sourceFiles(FRONTEND_SRC, [
  '.ts',
  '.svelte',
]).map((file) => [file, readFileSync(join(FRONTEND_SRC, file), 'utf8')]);

/** Name of a parameter, without its type annotation or default. */
function parameterName(parameter: string): string {
  return /^[A-Za-z_$][\w$]*/.exec(parameter)?.[0] ?? '';
}

const FUNCTION = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;

/** The narrowest named function whose body holds `at`, with its parameter names. */
function enclosingFunction(source: string, at: number): { name: string; parameters: string[] } | null {
  let innermost: { name: string; parameters: string[]; span: number } | null = null;
  for (const match of source.matchAll(FUNCTION)) {
    const open = match.index + match[0].length - 1;
    const parameters = matchingBracket(source, open);
    const bodyOpen = parameters === -1 ? -1 : source.indexOf('{', parameters);
    const bodyClose = bodyOpen === -1 ? -1 : matchingBracket(source, bodyOpen);
    if (bodyClose === -1 || at < bodyOpen || at > bodyClose) continue;
    const span = bodyClose - bodyOpen;
    if (innermost && innermost.span <= span) continue;
    innermost = {
      name: match[1]!,
      parameters: elements(source.slice(open + 1, parameters)).map(parameterName),
      span,
    };
  }
  return innermost === null ? null : { name: innermost.name, parameters: innermost.parameters };
}

/** String literals passed at `index` to every call of `name` under `frontend/src`. */
function callArguments(name: string, index: number): string[] {
  const values: string[] = [];
  const caller = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (const [, source] of frontendSources) {
    for (const match of source.matchAll(caller)) {
      if (source.slice(0, match.index).trimEnd().endsWith('function')) continue;
      if (inComment(source, match.index)) continue;
      const open = match.index + match[0].length - 1;
      const close = matchingBracket(source, open);
      if (close === -1) continue;
      const argument = elements(source.slice(open + 1, close))[index];
      const literal = argument === undefined ? null : STRING_LITERAL.exec(argument);
      if (literal) values.push(literal[2]!);
    }
  }
  return values;
}

/**
 * Roots of the array literal opening at `open`. A root that is an identifier is
 * a key factory parameterized by its caller (`createArtifactKeys("subagents")`
 * builds `[kind]`), so it resolves to the literals that factory is called with.
 */
function rootsAt(source: string, open: number): string[] {
  const close = matchingBracket(source, open);
  if (close === -1) return [];
  const first = elements(source.slice(open + 1, close))[0];
  if (first === undefined) return [];
  const literal = STRING_LITERAL.exec(first);
  if (literal) return [literal[2]!];
  if (!IDENTIFIER.test(first)) return [];
  const enclosing = enclosingFunction(source, open);
  const index = enclosing ? enclosing.parameters.indexOf(first) : -1;
  return index === -1 ? [] : callArguments(enclosing!.name, index);
}

function collectMappedKeys(): MappedKey[] {
  const source = blankComments(readFileSync(join(FRONTEND_SRC, EVENTS_FILE), 'utf8'));
  const declaration = source.indexOf('export const DEFAULT_INVALIDATIONS');
  const open = source.indexOf('{', declaration);
  const close = open === -1 ? -1 : matchingBracket(source, open);
  if (declaration === -1 || close === -1) return [];
  const body = source.slice(open + 1, close);
  const keys: MappedKey[] = [];
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === '"' || c === "'")) {
      let end = i + 1;
      while (end < body.length && body[end] !== c) end += body[end] === '\\' ? 2 : 1;
      let after = end + 1;
      while (/\s/.test(body[after] ?? '')) after++;
      if (body[after] === ':') {
        const event = body.slice(i + 1, end);
        const line = source.slice(0, open + 1 + i).split('\n').length;
        let value = after + 1;
        while (/\s/.test(body[value] ?? '')) value++;
        const valueEnd = body[value] === '[' ? matchingBracket(body, value) : -1;
        for (const key of valueEnd === -1 ? [] : elements(body.slice(value + 1, valueEnd))) {
          for (const root of key.startsWith('[') ? rootsAt(key, 0) : []) {
            keys.push({ event, root, line });
          }
        }
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return keys;
}

const QUERY_KEY_LITERAL = /\bqueryKey:\s*\[/g;
const CONST_KEY_LITERAL = /\[[^[\]]*\]\s*as const\b/g;

function collectQueryRoots(): Set<string> {
  const roots = new Set<string>();
  for (const [file, source] of frontendSources) {
    // The map is what is under test — its own keys cannot vouch for themselves.
    if (file === EVENTS_FILE) continue;
    for (const pattern of [QUERY_KEY_LITERAL, CONST_KEY_LITERAL]) {
      for (const match of source.matchAll(pattern)) {
        const open = match.index + match[0].indexOf('[');
        if (inComment(source, open)) continue;
        for (const root of rootsAt(source, open)) roots.add(root);
      }
    }
  }
  return roots;
}

const mappedKeys = collectMappedKeys();
const mappedRoots = new Set(mappedKeys.map((key) => key.root));
const queryRoots = collectQueryRoots();

describe('WS invalidation query key liveness', () => {
  it('extracts the keys and query roots it is meant to compare', () => {
    // A scan that silently matches nothing would pass every other assertion.
    expect(mappedKeys.length).toBeGreaterThan(80);
    expect(queryRoots.size).toBeGreaterThan(15);
    expect(mappedRoots.has('keys')).toBe(true);
    // A queryKey literal, a key factory constant, and a parameterized factory.
    expect(queryRoots.has('agents')).toBe(true);
    expect(queryRoots.has('settings')).toBe(true);
    expect(queryRoots.has('subagents')).toBe(true);
    // Event types and per-key sub-segments are not roots.
    expect(queryRoots.has('api-keys')).toBe(false);
    expect(mappedRoots.has('api-key.changed')).toBe(false);
  });

  it('maps every event to query keys some query actually uses', () => {
    const dead = [
      ...new Set(
        mappedKeys
          .filter((key) => !queryRoots.has(key.root) && !(key.root in UNUSED_QUERY_ROOTS))
          .map((key) => `${EVENTS_FILE}:${key.line} maps "${key.event}" to ["${key.root}", …]`),
      ),
    ];
    expect(
      dead,
      'point the entry at a key some query uses in frontend/src/lib/ws/events.ts, ' +
        'or record the root in UNUSED_QUERY_ROOTS here with a reason',
    ).toEqual([]);
  });

  it('keeps the allowlist free of stale entries', () => {
    const stale = Object.keys(UNUSED_QUERY_ROOTS).filter(
      (root) => !mappedRoots.has(root) || queryRoots.has(root),
    );
    expect(stale).toEqual([]);
    for (const reason of Object.values(UNUSED_QUERY_ROOTS)) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
