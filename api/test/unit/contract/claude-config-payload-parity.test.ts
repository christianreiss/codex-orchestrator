import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `/admin/claude/config` and `/admin/claude/config/store` return the
 * `ClientConfigService` results verbatim, and the frontend restates them as
 * `ClaudeConfigResponse` / `ClaudeConfigStoreResult`. A server key the frontend
 * never declares is a payload the admin UI cannot reach: the store result is
 * the one in the repo whose save verb rides on `change` rather than `status`
 * (`status` is always `'ok'`), and while `change` was typed `unknown` the
 * component compared `status === 'unchanged'` — a branch that never ran.
 *
 * Neither side is a value a test can inspect, and the frontend file sits
 * outside the api tsconfig — so both are parsed out as text. Only the direction
 * that hides a payload is checked: the frontend must declare every server key.
 * It is free to have more (`ClaudeConfigSettings` details are its own).
 */

const FRONTEND_FILE = 'frontend/src/lib/api/types.ts';
const SERVICE_FILE = 'api/src/services/client-config.ts';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Service interface -> the frontend interface that restates its payload. */
const MIRRORED = [
  { server: 'AdminFetchResult', frontend: 'ClaudeConfigResponse' },
  { server: 'StoreResult', frontend: 'ClaudeConfigStoreResult' },
] as const;

type FrontendName = (typeof MIRRORED)[number]['frontend'];

/**
 * Server keys the frontend deliberately leaves undeclared. Add one only with a
 * reason the admin UI can never have a use for the field.
 */
const ALLOWED_SERVER_ONLY: Record<FrontendName, readonly string[]> = {
  ClaudeConfigResponse: [],
  ClaudeConfigStoreResult: [],
};

/** The save verb the service emits; the frontend must state exactly this. */
const SERVICE_CHANGE_UNION = ['created', 'unchanged', 'updated'];

/** Blank out whole-line comments, keeping every other character at its offset. */
const blankComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');

const read = (file: string): string => blankComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));

const frontendSource = read(FRONTEND_FILE);
const serviceSource = read(SERVICE_FILE);

/** Body of the `interface <name> [extends ...] { ... }` declaration, braces counted. */
const interfaceBody = (source: string, file: string, name: string): string => {
  const match = new RegExp(`\\binterface\\s+${name}\\s+(?:extends\\s+[\\w\\s,]+)?\\{`).exec(source);
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
  MIRRORED.map((pair) => [pair.frontend, interfaceFields(frontendSource, FRONTEND_FILE, pair.frontend)] as const),
);
const SERVICE = new Map(
  MIRRORED.map((pair) => [pair.server, interfaceFields(serviceSource, SERVICE_FILE, pair.server)] as const),
);

describe('claude config payload parity', () => {
  it('extracts the interfaces it is meant to compare', () => {
    // A parser reading nothing — after a rename of a file or an interface, or a
    // reshape into a type alias — would pass every comparison below vacuously.
    // `StoreResult` restates the keys it inherits, so its body is the payload.
    expect([...SERVICE.get('AdminFetchResult')!.keys()], SERVICE_FILE).toEqual(
      expect.arrayContaining(['status', 'sha256', 'updated_at', 'size_bytes', 'content', 'settings']),
    );
    expect([...SERVICE.get('StoreResult')!.keys()], SERVICE_FILE).toEqual(
      expect.arrayContaining(['status', 'sha256', 'updated_at', 'size_bytes', 'content', 'settings', 'change']),
    );
    expect([...FRONTEND.get('ClaudeConfigResponse')!.keys()], FRONTEND_FILE).toEqual(
      expect.arrayContaining(['status', 'sha256', 'updated_at', 'settings']),
    );
    expect([...FRONTEND.get('ClaudeConfigStoreResult')!.keys()], FRONTEND_FILE).toEqual(
      expect.arrayContaining(['status', 'sha256', 'updated_at', 'change']),
    );
  });

  it('declares a frontend counterpart for every server key', () => {
    const missing = MIRRORED.flatMap((pair) => {
      const frontend = FRONTEND.get(pair.frontend)!;
      const allowed = ALLOWED_SERVER_ONLY[pair.frontend];
      return [...SERVICE.get(pair.server)!.keys()]
        .filter((field) => !frontend.has(field) && !allowed.includes(field))
        .map((field) => `${pair.server}.${field} -> ${pair.frontend}`);
    });
    expect(
      missing,
      `${FRONTEND_FILE} omits keys ${SERVICE_FILE} sends; either declare them or record them in ` +
        'ALLOWED_SERVER_ONLY with a reason',
    ).toEqual([]);
  });

  it('mirrors the service change union on ClaudeConfigStoreResult', () => {
    const service = unionMembers(SERVICE.get('StoreResult')!.get('change')!);
    expect(service, `${SERVICE_FILE} change union changed`).toEqual(SERVICE_CHANGE_UNION);
    expect(
      unionMembers(FRONTEND.get('ClaudeConfigStoreResult')!.get('change')!),
      `${FRONTEND_FILE} must state the save verbs the service emits: a widening such as "unknown" ` +
        'or "| string" is what let the component compare the verb against the wrong field',
    ).toEqual(service);
  });
});
