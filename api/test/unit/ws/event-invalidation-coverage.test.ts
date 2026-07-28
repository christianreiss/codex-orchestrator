import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_EVENT_TYPES } from '../../../src/ws/events.js';

/**
 * `AGENTS.md` requires every WS event the API publishes to be routed to query
 * keys by `DEFAULT_INVALIDATIONS` in `frontend/src/lib/ws/events.ts`. Producer
 * and consumer sit in different packages, so neither package's own suite can
 * see the drift: a new publish site without a map entry is a live backend event
 * the admin UI silently ignores, leaving stale data on screen.
 *
 * This test reads both sides as text — no imports across the package boundary —
 * and fails when a publish site has no matching entry and no allowlist reason.
 *
 * The same scan also holds `WS_EVENT_TYPES` in `api/src/ws/events.ts` to its
 * own claim of being the canonical catalog: nothing enforced it, so it drifted
 * in both directions (missing published types, declaring types nobody emits).
 *
 * Most admin mutations never call `wsPublisher.publish` themselves: they hand a
 * type to one of the two audit writers, which persists an `admin_events` row and
 * rebroadcasts it. Those call sites pass string literals, so the scan resolves
 * them too — otherwise the writers look like one dynamic publisher and the ~20
 * types behind them go unchecked.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, '../../../src');
const FRONTEND_EVENTS = resolve(HERE, '../../../../frontend/src/lib/ws/events.ts');

/** Published types that deliberately invalidate nothing, and why. */
const UNMAPPED_EVENT_TYPES: Record<string, string> = {
  toast: 'not an invalidation — wireWsToQueryClient hands the payload to the sonner toaster',
  'host.force_delete_ip_mismatch':
    'audit alarm only — the same request also publishes host.deleted, which refreshes the host queries',
};

/** Files that publish a type computed at runtime, and what feeds that type. */
const RUNTIME_TYPED_PUBLISHERS: Record<string, string> = {
  'services/shared-memories.ts': 'private publish() indirection — its callers pass shared_memory.* literals',
};

const PUBLISH_NEEDLE = 'wsPublisher.publish(';
/** `AdminEventsService.record({ type }, { broadcast })`. */
const RECORD_NEEDLE = '.record(';
/** `AdminEventsWriter.appendAndPublish(type, payload, { wsType })`. */
const APPEND_NEEDLE = '.appendAndPublish(';
const NEEDLES = [PUBLISH_NEEDLE, RECORD_NEEDLE, APPEND_NEEDLE];

/**
 * The two audit writers. Their own `wsPublisher.publish(` forwards whatever type
 * the caller handed them, so it is dynamic by construction; the scan resolves
 * those types at the call sites above and skips the forwarding publish itself.
 */
const INDIRECT_PUBLISHERS = ['services/admin-events.ts', 'services/admin-events-writer.ts'];

interface PublishSite {
  /** Path relative to `api/src`. */
  file: string;
  line: number;
  /** Every type the call can emit, or null when it is not statically known. */
  types: string[] | null;
}

/** Index of the `}`/`)`/`]` closing the bracket at `open`, or -1. */
function matchingBracket(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on the top-level commas of a call or object-literal body. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
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
    else if (depth === 0 && c === ',') {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.filter((part) => part.trim() !== '');
}

/** Source text of each call argument, given the index of the `(`. */
function callArguments(source: string, open: number): string[] | null {
  const close = matchingBracket(source, open);
  if (close === -1) return null;
  return splitTopLevel(source.slice(open + 1, close));
}

const PROPERTY_KEY = /^\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/;

/** Value expression of `key` in an object-literal expression, or null. */
function objectProperty(text: string, key: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  const close = matchingBracket(trimmed, 0);
  if (close === -1) return null;
  for (const entry of splitTopLevel(trimmed.slice(1, close))) {
    const named = PROPERTY_KEY.exec(entry);
    if (named && (named[2] ?? named[3]) === key) return entry.slice(named[0].length);
  }
  return null;
}

/** Split `cond ? a : b` into its branches, or null when it is not a ternary. */
function ternaryBranches(text: string): { consequent: string; alternate: string } | null {
  const marks: { char: string; index: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?') {
      // `??` and `?.` are not conditionals.
      if (text[i + 1] === '?' || text[i + 1] === '.') i++;
      else marks.push({ char: '?', index: i });
    } else if (depth === 0 && c === ':') marks.push({ char: ':', index: i });
  }
  const question = marks[0];
  if (!question || question.char !== '?') return null;
  let open = 0;
  for (const mark of marks) {
    if (mark.char === '?') open++;
    else if (--open === 0) {
      return {
        consequent: text.slice(question.index + 1, mark.index),
        alternate: text.slice(mark.index + 1),
      };
    }
  }
  return null;
}

/** Every string a template literal body can produce, or null. */
function templateTypes(body: string): string[] | null {
  let produced = [''];
  let literal = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$' && body[i + 1] === '{') {
      const end = matchingBracket(body, i + 1);
      if (end === -1) return null;
      const substituted = eventTypesOf(body.slice(i + 2, end));
      if (!substituted) return null;
      const prefix = literal;
      produced = produced.flatMap((head) => substituted.map((value) => head + prefix + value));
      literal = '';
      i = end;
      continue;
    }
    literal += body[i];
  }
  const suffix = literal;
  return produced.map((head) => head + suffix);
}

const STRING_LITERAL = /^(['"])((?:\\.|(?!\1).)*)\1$/;

/** Every event type an expression can evaluate to, or null when it is dynamic. */
function eventTypesOf(expression: string): string[] | null {
  const text = expression.trim();
  const literal = STRING_LITERAL.exec(text);
  if (literal) return [literal[2]!];
  if (text.length > 1 && text.startsWith('`') && text.endsWith('`')) return templateTypes(text.slice(1, -1));
  const branches = ternaryBranches(text);
  if (!branches) return null;
  const consequent = eventTypesOf(branches.consequent);
  const alternate = eventTypesOf(branches.alternate);
  if (!consequent || !alternate) return null;
  return [...consequent, ...alternate];
}

/** Every type a call through `needle` broadcasts, or null when it is dynamic. */
function broadcastTypes(needle: string, args: string[]): string[] | null {
  if (needle === PUBLISH_NEEDLE) return args[0] === undefined ? null : eventTypesOf(args[0]);
  if (needle === RECORD_NEEDLE) {
    // The audit row is always written; the WS event only when `broadcast` is
    // not explicitly false.
    const input = args[0];
    if (input === undefined) return null;
    const broadcast = args[1] === undefined ? null : objectProperty(args[1], 'broadcast');
    if (broadcast !== null && broadcast.trim() === 'false') return [];
    const type = objectProperty(input, 'type');
    return type === null ? null : eventTypesOf(type);
  }
  // `wsType` overrides the audit type for the broadcast only.
  const wsType = args[2] === undefined ? null : objectProperty(args[2], 'wsType');
  const expression = wsType ?? args[0];
  return expression === undefined ? null : eventTypesOf(expression);
}

function collectPublishSites(): PublishSite[] {
  const sites: PublishSite[] = [];
  const files = readdirSync(API_SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  for (const file of files.sort()) {
    const source = readFileSync(join(API_SRC, file), 'utf8');
    const lines = source.split('\n');
    let lineStart = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      // Doc comments mention `wsPublisher.publish(type, payload)` in prose.
      const trimmed = line.trimStart();
      const isComment = trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
      for (const needle of NEEDLES) {
        if (needle === PUBLISH_NEEDLE && INDIRECT_PUBLISHERS.includes(file)) continue;
        let at = isComment ? -1 : line.indexOf(needle);
        while (at !== -1) {
          const args = callArguments(source, lineStart + at + needle.length - 1);
          sites.push({
            file,
            line: index + 1,
            types: args === null ? null : broadcastTypes(needle, args),
          });
          at = line.indexOf(needle, at + 1);
        }
      }
      lineStart += line.length + 1;
    }
  }
  return sites;
}

/** Top-level keys of the `DEFAULT_INVALIDATIONS` object literal. */
function invalidationKeys(source: string): string[] {
  const declaration = source.indexOf('export const DEFAULT_INVALIDATIONS');
  const open = source.indexOf('{', declaration);
  const close = matchingBracket(source, open);
  if (declaration === -1 || open === -1 || close === -1) return [];
  const body = source.slice(open + 1, close);
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === '"' || c === "'")) {
      let end = i + 1;
      while (end < body.length && body[end] !== c) end += body[end] === '\\' ? 2 : 1;
      let after = end + 1;
      while (after < body.length && /\s/.test(body[after]!)) after++;
      if (body[after] === ':') keys.push(body.slice(i + 1, end));
      i = end;
    }
  }
  return keys;
}

const sites = collectPublishSites();
const publishedTypes = new Set(sites.flatMap((site) => site.types ?? []));
const mappedTypes = new Set(invalidationKeys(readFileSync(FRONTEND_EVENTS, 'utf8')));
const catalogedTypes = new Set<string>(WS_EVENT_TYPES);

describe('WS event invalidation coverage', () => {
  it('extracts the publish sites it is meant to guard', () => {
    // A scan that silently matches nothing would pass every other assertion.
    expect(sites.length).toBeGreaterThan(80);
    expect(mappedTypes.size).toBeGreaterThan(50);
    expect(catalogedTypes.size).toBeGreaterThan(50);
    expect(publishedTypes.has('host.updated')).toBe(true);
    // Resolved through a ternary and a template literal respectively.
    expect(publishedTypes.has('skill.stored')).toBe(true);
    expect(publishedTypes.has('project.note.updated')).toBe(true);
    // Ternary conditions are not event types.
    expect(publishedTypes.has('created')).toBe(false);
  });

  it('resolves the types the audit writers rebroadcast for their callers', () => {
    // Both reach the socket only through a writer: `record({ type })` in
    // admin-users.ts and the `wsType` override in insecure-window-admin.ts.
    expect(publishedTypes.has('user.created')).toBe(true);
    expect(publishedTypes.has('insecure.domain.revoked')).toBe(true);
    // `record(..., { broadcast: false })` writes an audit row and nothing else.
    expect(publishedTypes.has('admin.auth.password.change')).toBe(false);
    // The writers still forward — without that, the scan above guards nothing.
    for (const file of INDIRECT_PUBLISHERS) {
      expect(readFileSync(join(API_SRC, file), 'utf8')).toContain(PUBLISH_NEEDLE);
    }
  });

  it('routes every published event type to a frontend invalidation entry', () => {
    const drift = sites.flatMap((site) =>
      (site.types ?? [])
        .filter((type) => !mappedTypes.has(type) && !(type in UNMAPPED_EVENT_TYPES))
        .map((type) => `${site.file}:${site.line} publishes "${type}"`),
    );
    expect(
      drift,
      'add the event type to DEFAULT_INVALIDATIONS in frontend/src/lib/ws/events.ts, ' +
        'or to UNMAPPED_EVENT_TYPES here with a reason',
    ).toEqual([]);
  });

  it('lists every published event type in the WS_EVENT_TYPES catalog', () => {
    const missing = sites.flatMap((site) =>
      (site.types ?? [])
        .filter((type) => !catalogedTypes.has(type))
        .map((type) => `${site.file}:${site.line} publishes "${type}"`),
    );
    expect(missing, 'add the event type to WS_EVENT_TYPES in api/src/ws/events.ts').toEqual([]);
  });

  it('catalogs no event type that is neither published nor consumed', () => {
    const orphaned = WS_EVENT_TYPES.filter(
      (type) => !publishedTypes.has(type) && !mappedTypes.has(type),
    ).map((type) => `WS_EVENT_TYPES declares "${type}"`);
    expect(
      orphaned,
      'nothing under api/src publishes it and DEFAULT_INVALIDATIONS does not route it — ' +
        'drop it from WS_EVENT_TYPES in api/src/ws/events.ts',
    ).toEqual([]);
  });

  it('accounts for every publish site whose event type is computed at runtime', () => {
    const unexplained = sites
      .filter((site) => site.types === null && !(site.file in RUNTIME_TYPED_PUBLISHERS))
      .map((site) => `${site.file}:${site.line}`);
    expect(
      unexplained,
      'publish a string literal, or record the file in RUNTIME_TYPED_PUBLISHERS with a reason',
    ).toEqual([]);
  });

  it('keeps both allowlists free of stale entries', () => {
    const stale = [
      ...Object.keys(UNMAPPED_EVENT_TYPES).filter(
        (type) => !publishedTypes.has(type) || mappedTypes.has(type),
      ),
      ...Object.keys(RUNTIME_TYPED_PUBLISHERS).filter(
        (file) => !sites.some((site) => site.file === file && site.types === null),
      ),
    ];
    expect(stale).toEqual([]);
    for (const reason of [
      ...Object.values(UNMAPPED_EVENT_TYPES),
      ...Object.values(RUNTIME_TYPED_PUBLISHERS),
    ]) {
      expect(reason.trim()).not.toBe('');
      expect(reason).not.toContain('\n');
    }
  });
});
