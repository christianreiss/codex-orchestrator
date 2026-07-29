import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The frontend runner client declares its response shapes as mirrors of the
 * ones in `RunnerProxyService`, and a field it declares that no response
 * carries is an invitation for a component to render it: it carried
 * `updated_auth?: Record<string, unknown>` — the runner's freshly-refreshed
 * OAuth/API credentials — which `formatRunResult` deliberately strips, because
 * `/admin/runner/run` and `/run-claude` return that object verbatim.
 *
 * Neither side is a value a test can inspect, and the frontend file sits
 * outside the api tsconfig — so both are parsed out as text. Only the direction
 * that advertises a payload no response carries is checked: the frontend may
 * not declare a field the server interface does not. The server is free to have
 * more (`canonical_digest` and friends need no frontend counterpart).
 */

const FRONTEND_FILE = 'frontend/src/lib/api/runner.ts';
const SERVICE_FILE = 'api/src/services/runner-proxy.ts';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Interfaces both files declare under the same name, compared field for field. */
const MIRRORED = ['RunnerRunResult', 'RunnerStatus', 'RunnerEngineStatus'] as const;

type Mirrored = (typeof MIRRORED)[number];

/**
 * Frontend-only fields that are deliberate. Add one only with a reason the
 * admin API response genuinely cannot carry a server counterpart.
 */
const ALLOWED_FRONTEND_ONLY: Record<Mirrored, readonly string[]> = {
  RunnerRunResult: [],
  RunnerStatus: [],
  RunnerEngineStatus: [],
};

/**
 * Never declarable on the frontend — allowlist or not, and whether or not the
 * server interface grows one. `formatRunResult` strips `updated_auth` precisely
 * so live credentials never reach the admin API client.
 */
const FORBIDDEN_FIELDS = ['updated_auth'];

/** The status union the service emits; the frontend must state exactly this. */
const SERVICE_STATUS_UNION = ['fail', 'ok', 'unconfigured'];

/** Blank out whole-line comments, keeping every other character at its offset. */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const read = (file: string): string => blankComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));

const frontendSource = read(FRONTEND_FILE);
const serviceSource = read(SERVICE_FILE);

/** Body of the `interface <name> { ... }` declaration, braces counted. */
const interfaceBody = (source: string, file: string, name: string): string => {
  const match = new RegExp(`\\binterface\\s+${name}\\s*\\{`).exec(source);
  if (!match) throw new Error(`interface ${name} not found in ${file}`);
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unterminated interface ${name} in ${file}`);
};

/** The members at the top level of an interface body, split on their `;`. */
const topLevelMembers = (body: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ';' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((member) => member.trim()).filter((member) => member !== '');
};

/** Field name -> its declared type text. Index signatures are not fields. */
const interfaceFields = (source: string, file: string, name: string): Map<string, string> => {
  const fields = new Map<string, string>();
  for (const member of topLevelMembers(interfaceBody(source, file, name))) {
    if (member.startsWith('[')) continue;
    const field = /^(\w+)\s*\??\s*:([\s\S]*)$/.exec(member);
    if (!field) throw new Error(`unparsable member in ${name} of ${file}: ${member}`);
    fields.set(field[1]!, field[2]!.trim());
  }
  return fields;
};

/** Union members of a type text, string literals unquoted, others left as-is. */
const unionMembers = (declaration: string): string[] =>
  declaration
    .split('|')
    .map((part) => part.trim())
    .map((part) => /^['"](\w+)['"]$/.exec(part)?.[1] ?? part)
    .sort();

const FRONTEND = new Map(
  MIRRORED.map((name) => [name, interfaceFields(frontendSource, FRONTEND_FILE, name)] as const),
);
const SERVICE = new Map(
  MIRRORED.map((name) => [name, interfaceFields(serviceSource, SERVICE_FILE, name)] as const),
);

const fieldsOf = (side: Map<Mirrored, Map<string, string>>, name: Mirrored): Map<string, string> =>
  side.get(name)!;

describe('frontend runner result fields', () => {
  it('extracts the interfaces it is meant to compare', () => {
    // A parser reading nothing — after a rename of a file or an interface, or a
    // reshape into a type alias — would pass every comparison below vacuously.
    expect([...fieldsOf(SERVICE, 'RunnerRunResult').keys()], SERVICE_FILE).toEqual(
      expect.arrayContaining(['status', 'reason', 'canonical_digest', 'payload_id']),
    );
    expect([...fieldsOf(SERVICE, 'RunnerStatus').keys()], SERVICE_FILE).toEqual(
      expect.arrayContaining(['configured', 'url', 'ready', 'detail', 'engines']),
    );
    expect([...fieldsOf(SERVICE, 'RunnerEngineStatus').keys()], SERVICE_FILE).toEqual(
      expect.arrayContaining(['state', 'last_check', 'last_ok', 'last_fail']),
    );
    expect([...fieldsOf(FRONTEND, 'RunnerRunResult').keys()], FRONTEND_FILE).toEqual(
      expect.arrayContaining(['status', 'detail', 'reachable', 'latency_ms']),
    );
    expect([...fieldsOf(FRONTEND, 'RunnerStatus').keys()], FRONTEND_FILE).toEqual(
      expect.arrayContaining(['configured', 'url', 'ready', 'detail', 'engines']),
    );
    expect([...fieldsOf(FRONTEND, 'RunnerEngineStatus').keys()], FRONTEND_FILE).toEqual(
      expect.arrayContaining(['state', 'last_check', 'last_ok', 'last_fail']),
    );
  });

  it('never declares a credential field the proxy strips', () => {
    const declared = MIRRORED.flatMap((name) =>
      FORBIDDEN_FIELDS.filter((field) => fieldsOf(FRONTEND, name).has(field)).map(
        (field) => `${name}.${field}`,
      ),
    );
    expect(
      declared,
      `${FRONTEND_FILE} may never declare ${FORBIDDEN_FIELDS.join(', ')}: formatRunResult in ` +
        `${SERVICE_FILE} strips the runner's freshly-refreshed credentials so they are never ` +
        'echoed back to the admin API client, and a declared field invites one to be rendered',
    ).toEqual([]);
  });

  it('declares no field the service interface does not', () => {
    const drift = MIRRORED.flatMap((name) => {
      const server = fieldsOf(SERVICE, name);
      const allowed = ALLOWED_FRONTEND_ONLY[name];
      return [...fieldsOf(FRONTEND, name).keys()]
        .filter((field) => !server.has(field) && !allowed.includes(field))
        .map((field) => `${name}.${field}`);
    });
    expect(
      drift,
      `${FRONTEND_FILE} advertises fields no ${SERVICE_FILE} response carries; either drop them ` +
        'or record them in ALLOWED_FRONTEND_ONLY with a reason',
    ).toEqual([]);
  });

  it('mirrors the service status union on RunnerRunResult', () => {
    const service = unionMembers(fieldsOf(SERVICE, 'RunnerRunResult').get('status')!);
    expect(service, `${SERVICE_FILE} status union changed`).toEqual(SERVICE_STATUS_UNION);
    expect(
      unionMembers(fieldsOf(FRONTEND, 'RunnerRunResult').get('status')!),
      `${FRONTEND_FILE} must state the statuses the service emits: a widening such as "| string" ` +
        'or a member it never returns makes the union useless for narrowing',
    ).toEqual(service);
  });
});
