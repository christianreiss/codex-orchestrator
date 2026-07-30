import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expressionAt,
  firstArgument,
  matchingBracket,
  skipTypeArguments,
  sourceFiles,
  stripComments,
  STRING_LITERAL,
} from './registered-routes.js';

/**
 * `docs/LOGIN.md` and `docs/ADMIN.md` both state that the whole route tree
 * holds exactly four role gates, and `docs/LOGIN.md` enumerates the seventeen
 * `METHOD /path` registrations they cover. In code the gates are four
 * module-local preHandlers: portal mutation, memory mutation, source mutation,
 * and user management. They are attached per route by hand. Adding a
 * protected mutation without one silently
 * opens it to every `viewer` and legacy `user`, and both docs go stale while
 * every other suite stays green: `admin-doc-capability-truth.test.ts` only
 * checks that no phantom capability or role *name* is documented, and
 * `login-doc-admin-auth-endpoints.test.ts` only checks that the endpoints
 * exist, not that they are gated.
 *
 * This scan discovers the gates from the source — a preHandler is a gate when
 * it raises `admin_role_required` — and fails when a gate lives anywhere else,
 * when the gated route set differs in either direction from what the
 * `docs/LOGIN.md` role-gate bullet enumerates, or when a route that must be
 * gated by policy carries no gate at all.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, '../../../src');
const DOC = resolve(HERE, '../../../../docs/LOGIN.md');

/** The error code every role gate answers with; how a gate is recognized. */
const ROLE_CODE = 'admin_role_required';

/** The four gates both docs claim are the whole inventory, and where they live. */
const KNOWN_GATES: Record<string, string> = {
  requireAgentPortalMutationRole: 'routes/agent-portal/admin-host.ts',
  requireMutationRole: 'routes/admin/memories/index.ts',
  requireSourceMutationRole: 'routes/admin/skill-sources/index.ts',
  requireUserManagementRole: 'routes/admin/users/index.ts',
};

/**
 * The gated registrations as they stand today. Pinned so that a regex which
 * stops matching cannot quietly turn the comparison against `docs/LOGIN.md`
 * into a test of two empty sets. A ninth gate is meant to fail here: add it
 * below and to the role-gate bullets in `docs/LOGIN.md` and `docs/ADMIN.md`.
 */
const PINNED_GATED_ROUTES = [
  'DELETE /admin/agent-portal/users/:id',
  'DELETE /admin/memories/:scope/:recordId',
  'DELETE /admin/users/:id',
  // Reads the permanent portal link back out of storage: a GET, but bearer
  // material, so it carries the same gate as the mutations.
  'GET /admin/agent-portal/users/:id/link',
  'PATCH /admin/memories/:scope/:recordId',
  'POST /admin/agent-portal/state',
  'POST /admin/agent-portal/users',
  'POST /admin/agent-portal/users/:id',
  'POST /admin/agent-portal/users/:id/enabled',
  'POST /admin/agent-portal/users/:id/rotate',
  'POST /admin/memories/:scope',
  'POST /admin/memories/shared/:recordId/append',
  'POST /admin/skill-sources/mattpocock',
  'POST /admin/skill-sources/mattpocock/refresh',
  'POST /admin/users',
  'POST /admin/users/:id',
  'POST /admin/users/wipe',
];

/** Routes that must carry a gate, whether or not the docs enumerate them. */
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
const READ_ONLY_BY_DESIGN = ['GET /admin/users'];

const CONST_BINDING = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g;
const REGISTRAR = /\bapp\.(get|post|put|patch|delete|options)\b/g;
const ROUTE_OBJECT = /\bapp\.route\b/g;
const URL_PROPERTY = /\burl:\s*(['"`])([^'"`]*)\1/;
const METHOD_PROPERTY = /\bmethod:\s*(['"`])([^'"`]*)\1/;

/** The section of `docs/LOGIN.md` that describes the role model. */
const ROLES_HEADING = '## Roles & Role Gates';
/** A documented endpoint span: `POST /admin/users`, `PATCH|DELETE /admin/…`. */
const VERB = '(?:GET|POST|PUT|PATCH|DELETE|OPTIONS)';
const DOC_ROUTE = new RegExp(`\`(${VERB}(?:\\|${VERB})*) (/[^\`\\s]+)\``, 'g');
/** A documented `{param}` / registered `:param` segment. */
const PARAM = ':param';

interface GateHelper {
  name: string;
  /** Module, relative to `api/src`. */
  file: string;
  line: number;
  /** Offsets of the `const` binding and of the end of its initializer. */
  start: number;
  end: number;
}

interface Registration {
  /** `METHOD /path` as registered. */
  text: string;
  method: string;
  path: string;
  file: string;
  line: number;
  /** Route options source text, where a `preHandler` names its gates. */
  options: string;
}

interface DocClaim {
  line: number;
  /** `METHOD /path` as written, for the failure message. */
  text: string;
  /** `METHOD /path` with params normalized, for the comparison. */
  key: string;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Turn `{param}` / `:param` segments into `PARAM`. */
function normalizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => (/^(?:\{.+\}|:.+)$/.test(segment) ? PARAM : segment))
    .join('/');
}

function normalize(text: string): string {
  const [method, path] = text.split(' ');
  return `${method} ${normalizePath(path!)}`;
}

const SOURCES = new Map(
  sourceFiles(API_SRC, ['.ts']).map((file) => [
    file,
    stripComments(readFileSync(join(API_SRC, file), 'utf8')),
  ]),
);

/** Every `const` whose initializer raises `ROLE_CODE`: the role gates. */
function collectGateHelpers(): GateHelper[] {
  const helpers: GateHelper[] = [];
  for (const [file, source] of SOURCES) {
    for (const match of source.matchAll(CONST_BINDING)) {
      const after = match.index + match[0].length;
      const initializer = expressionAt(source, after);
      if (!initializer.includes(ROLE_CODE)) continue;
      helpers.push({
        name: match[1]!,
        file,
        line: lineAt(source, match.index),
        start: match.index,
        end: after + initializer.length,
      });
    }
  }
  return helpers;
}

/** Occurrences of `ROLE_CODE` that no gate helper accounts for. */
function strayRoleChecks(): string[] {
  const stray: string[] = [];
  for (const [file, source] of SOURCES) {
    const spans = helpers.filter((helper) => helper.file === file);
    for (let at = source.indexOf(ROLE_CODE); at !== -1; at = source.indexOf(ROLE_CODE, at + 1)) {
      if (spans.some((span) => at >= span.start && at < span.end)) continue;
      stray.push(`${file}:${lineAt(source, at)} raises ${ROLE_CODE}`);
    }
  }
  return stray;
}

/**
 * Options object of the call whose `(` sits at `open`, given the source text of
 * its first argument. Empty when the registration passes the handler directly,
 * which carries no preHandler at all.
 */
function optionsObject(source: string, open: number, first: string): string {
  let i = open + 1 + first.length;
  if (source[i] === ',') i++;
  while (/\s/.test(source[i] ?? '')) i++;
  if (source[i] !== '{') return '';
  const close = matchingBracket(source, i);
  return close === -1 ? '' : source.slice(i, close + 1);
}

/** Every route registration under `api/src/routes`, with its options text. */
function collectRegistrations(): Registration[] {
  const registrations: Registration[] = [];
  for (const [file, source] of SOURCES) {
    if (!file.startsWith('routes/')) continue;
    for (const match of source.matchAll(REGISTRAR)) {
      const open = skipTypeArguments(source, match.index + match[0].length);
      if (source[open] !== '(') continue;
      const first = firstArgument(source, open);
      const literal = first === null ? null : STRING_LITERAL.exec(first.trim());
      if (!literal) continue;
      const method = match[1]!.toUpperCase();
      const path = literal[2]!;
      registrations.push({
        text: `${method} ${path}`,
        method,
        path,
        file,
        line: lineAt(source, match.index),
        options: optionsObject(source, open, first!),
      });
    }
    for (const match of source.matchAll(ROUTE_OBJECT)) {
      const options = firstArgument(source, match.index + match[0].length);
      const url = options === null ? null : URL_PROPERTY.exec(options);
      const method = options === null ? null : METHOD_PROPERTY.exec(options);
      if (!url || !method) continue;
      const verb = method[2]!.toUpperCase();
      const path = url[2]!;
      registrations.push({
        text: `${verb} ${path}`,
        method: verb,
        path,
        file,
        line: lineAt(source, match.index),
        options: options!,
      });
    }
  }
  return registrations;
}

/** True when the registration options name one of the discovered gates. */
function gated(registration: Registration): boolean {
  return helpers.some((helper) => new RegExp(`\\b${helper.name}\\b`).test(registration.options));
}

/** True when the route serves a prefix whose gate policy this suite enforces. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Logical top-level bullets of the roles section: the `- ` line plus every
 * continuation and nested line under it, so a bullet whose enumeration runs
 * over several lines is read as one claim.
 */
function roleGateBullets(lines: string[]): { line: number; text: string }[] {
  const start = lines.findIndex((line) => line.trim() === ROLES_HEADING);
  if (start === -1) return [];
  const bullets: { line: number; text: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('## ')) break;
    if (!line.startsWith('- ')) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith('- ') && !lines[end]!.startsWith('## ')) {
      end++;
    }
    bullets.push({ line: i + 1, text: lines.slice(i, end).join('\n') });
  }
  return bullets;
}

/** The `METHOD /path` spans the role-gate bullet enumerates. */
function collectDocClaims(): DocClaim[] {
  const bullets = roleGateBullets(DOC_LINES).filter((bullet) => bullet.text.includes(ROLE_CODE));
  if (bullets.length !== 1) {
    throw new Error(`docs/LOGIN.md has ${bullets.length} role-gate bullets under ${ROLES_HEADING}`);
  }
  const bullet = bullets[0]!;
  const claims: DocClaim[] = [];
  for (const match of bullet.text.matchAll(DOC_ROUTE)) {
    const line = bullet.line + lineAt(bullet.text, match.index) - 1;
    for (const method of match[1]!.split('|')) {
      claims.push({
        line,
        text: `${method} ${match[2]}`,
        key: `${method} ${normalizePath(match[2]!)}`,
      });
    }
  }
  return claims;
}

const DOC_LINES = readFileSync(DOC, 'utf8').split('\n');
const helpers = collectGateHelpers();
const registrations = collectRegistrations();
const gates = registrations.filter(gated);
const claims = collectDocClaims();
const claimed = new Set(claims.map((claim) => claim.key));

describe('owner/admin role gate inventory', () => {
  it('finds the gates, the registrations and the doc bullet it holds them against', () => {
    // A scan that silently matched nothing would pass every assertion below.
    expect(SOURCES.size).toBeGreaterThan(50);
    expect(registrations.length).toBeGreaterThan(100);
    expect(
      Object.fromEntries(helpers.map((helper) => [helper.name, helper.file])),
      'the docs claim these four gates and no others',
    ).toEqual(KNOWN_GATES);
    // The gated set is pinned so the comparison below cannot become vacuous.
    expect(gates.map((gate) => gate.text).sort()).toEqual(PINNED_GATED_ROUTES);
    expect(claims).toHaveLength(PINNED_GATED_ROUTES.length);
    // `{scope}` / `{recordId}` segments normalize onto the registered params,
    // and `PATCH|DELETE /path` counts as the two claims it writes.
    expect(claimed.has(`POST /admin/memories/${PARAM}`)).toBe(true);
    expect(claimed.has(`PATCH /admin/memories/${PARAM}/${PARAM}`)).toBe(true);
    expect(claimed.has(`DELETE /admin/memories/${PARAM}/${PARAM}`)).toBe(true);
  });

  it('raises admin_role_required only inside the four documented gates', () => {
    expect(
      strayRoleChecks(),
      `another role gate makes the "exactly four role gates" claim in docs/LOGIN.md and ` +
        'docs/ADMIN.md false — document it there and record it in KNOWN_GATES here',
    ).toEqual([]);
  });

  it('gates exactly the routes the docs/LOGIN.md role-gate bullet enumerates', () => {
    const undocumented = gates
      .filter((gate) => !claimed.has(normalize(gate.text)))
      .map((gate) => `${gate.file}:${gate.line} gates ${gate.text}, and docs/LOGIN.md omits it`);
    expect(undocumented, 'add it to the role-gate bullets in docs/LOGIN.md').toEqual([]);
  });

  it('registers a gated route for every endpoint that bullet claims', () => {
    const registered = new Set(gates.map((gate) => normalize(gate.text)));
    const phantom = claims
      .filter((claim) => !registered.has(claim.key))
      .map((claim) => `docs/LOGIN.md:${claim.line} claims ${claim.text} is role-gated`);
    expect(
      phantom,
      'the route is gone or lost its gate — restore the gate, or fix docs/LOGIN.md',
    ).toEqual([]);
  });

  it('gates every agent-portal/memories write and every /admin/users mutation', () => {
    const open = registrations
      .filter((route) => !gates.includes(route))
      .filter(
        (route) =>
          (under(route.path, '/admin/agent-portal') && MUTATING.includes(route.method)) ||
          (under(route.path, '/admin/memories') && MUTATING.includes(route.method)) ||
          (under(route.path, '/admin/users') && !READ_ONLY_BY_DESIGN.includes(route.text)),
      )
      .map((route) => `${route.file}:${route.line} registers ${route.text} with no role gate`);
    expect(
      open,
      'every viewer and legacy user can call it — add the role gate to its preHandler list',
    ).toEqual([]);
  });
});
