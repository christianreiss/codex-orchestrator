import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The API hand-builds every runner request: `runner-client.ts` derives
 * `/verify-claude`, `/skills/generate`, `/skills/assist` and `/projects/assist`
 * from AUTH_RUNNER_URL, and the two adapters derive `/exec`. `runner/app.py`
 * validates each body against a pydantic `BaseModel`. Nothing compared the two
 * sides: the API suite mocks the runner, the runner suite never sees the API's
 * bodies, so renaming a required field or a route path turns every live call
 * into a 422/404 with both suites green.
 *
 * This scan pairs each request body the API builds (the object literal carrying
 * `auth_json`) with the path its target URL resolves to, and fails when the
 * runner has no `@app.post` for that path or the body omits a required field of
 * the model behind it. Only top-level fields are compared — nested models
 * (`SkillAssistMessage`, `SkillAssistDraft`) are filled from typed API values,
 * not from literals this scan could read.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SERVICES = resolve(HERE, '../../../src/services');
const RUNNER_APP = resolve(HERE, '../../../../runner/app.py');

const CLIENT_FILES = ['runner-client.ts', 'adapters/runner-openai.ts', 'adapters/runner-claude.ts'];

/**
 * AUTH_RUNNER_URL is the runner's `/verify` endpoint — every other target is
 * derived from it by rewriting that suffix (`deriveClaudeUrl`,
 * `deriveFeatureUrl`, `runnerExecUrl`), so a target that resolves to no literal
 * path of its own posts to `/verify`.
 */
const BASE_PATH = '/verify';

/** Every runner request body carries the auth snapshot under this key. */
const BODY_MARKER = 'auth_json';

interface RequestSite {
  /** Path relative to the repository root. */
  file: string;
  line: number;
  /** Runner path the target URL resolves to. */
  path: string;
  /** False when the target is AUTH_RUNNER_URL itself rather than a derived path. */
  derived: boolean;
  /** Top-level keys of the JSON body the API sends. */
  keys: string[];
}

// --- shared source scanning -------------------------------------------------

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

/** Source text of the first call argument, given the index of the `(`. */
function firstArgument(source: string, open: number): string | null {
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
      if (depth === 0) return source.slice(open + 1, i);
    } else if (c === ',' && depth === 1) return source.slice(open + 1, i);
  }
  return null;
}

/** Expression text starting at `start`, up to the `;`/newline that ends it. */
function expressionAt(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === ';' || c === '\n')) return source.slice(start, i);
  }
  return source.slice(start);
}

// --- what the API sends -----------------------------------------------------

/** Index of the quote/comment/bracket-aware end of the token starting at `i`. */
function skipLiteral(source: string, i: number): number {
  const c = source[i]!;
  if (c === '/' && source[i + 1] === '/') {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end;
  }
  if (c === '/' && source[i + 1] === '*') {
    const end = source.indexOf('*/', i);
    return end === -1 ? source.length : end + 1;
  }
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === '\\') j++;
    else if (source[j] === c) return j;
  }
  return source.length;
}

const QUOTE = /['"`]/;

/** Opening brace of every object literal that declares a top-level `auth_json` key. */
function requestBodies(source: string): { open: number; parent: number | null }[] {
  const stack: number[] = [];
  const bodies: { open: number; parent: number | null }[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (QUOTE.test(c) || (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*'))) {
      i = skipLiteral(source, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      stack.push(i);
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      stack.pop();
      continue;
    }
    if (!source.startsWith(BODY_MARKER, i) || /[\w$]/.test(source[i - 1] ?? '')) continue;
    let after = i + BODY_MARKER.length;
    while (/\s/.test(source[after] ?? '')) after++;
    const open = stack[stack.length - 1];
    if (source[after] !== ':' || open === undefined || source[open] !== '{') continue;
    bodies.push({ open, parent: stack[stack.length - 2] ?? null });
  }
  return bodies;
}

/** Index just past the value starting at `start`, i.e. the next top-level `,`. */
function endOfValue(body: string, start: number): number {
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const c = body[i]!;
    if (QUOTE.test(c)) {
      i = skipLiteral(body, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return body.length;
}

const KEY = /^([A-Za-z_$][\w$]*)/;

/** Top-level keys of an object literal, shorthand properties included. */
function topLevelKeys(source: string, open: number): string[] {
  const close = matchingBracket(source, open);
  const body = source.slice(open + 1, close);
  const keys: string[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    const key = KEY.exec(body.slice(i));
    if (!key) break;
    i += key[0].length;
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] === ':') {
      keys.push(key[1]!);
      i = endOfValue(body, i + 1);
    } else if (body[i] === ',' || i >= body.length) {
      keys.push(key[1]!);
    } else break;
  }
  return keys;
}

const SENDER = /\b(?:send|fetch|fetcher|fetchImpl)\s*$/;
const DECLARATION = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*$/;

/** URL expression the body at `open` is posted to, or null. */
function targetExpression(source: string, open: number, parent: number | null): string | null {
  const before = source.slice(0, open).trimEnd();
  // `send(target, { … })` — the body is an argument of the sending call.
  if (before.endsWith(',') && parent !== null && source[parent] === '(') {
    if (!SENDER.test(source.slice(0, parent))) return null;
    return firstArgument(source, parent);
  }
  // `const body = { … }` — the body is serialized into a later fetch call.
  const declared = DECLARATION.exec(before);
  if (!declared) return null;
  const serialized = `JSON.stringify(${declared[1]})`;
  for (const call of source.matchAll(/\b(?:fetch|fetcher|fetchImpl)\s*\(/g)) {
    const callOpen = call.index + call[0].length - 1;
    const args = source.slice(callOpen, matchingBracket(source, callOpen) + 1);
    if (args.includes(serialized)) return firstArgument(source, callOpen);
  }
  return null;
}

const QUOTED_PATH = /(['"`])(\/[a-z][a-z0-9\-/]*)\1/g;
const TEMPLATE_TAIL_PATH = /\}(\/[a-z][a-z0-9\-/]*)`/g;

function pathLiterals(expression: string): string[] {
  return [
    ...[...expression.matchAll(QUOTED_PATH)].map((match) => match[2]!),
    ...[...expression.matchAll(TEMPLATE_TAIL_PATH)].map((match) => match[1]!),
  ];
}

/**
 * Text of the `const <name> = …` initializer in effect at `at` — the last one
 * declared above it, since `target` is redeclared in every client method.
 */
function declarationOf(name: string, source: string, at: number): string | null {
  const declarations = [...source.matchAll(new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=\\n]*=`, 'g'))];
  const declaration = declarations.filter((match) => match.index < at).pop();
  if (!declaration) return null;
  return expressionAt(source, declaration.index + declaration[0].length).trim();
}

/** Paths returned by the module-local `function <name>(…)`, if there is one. */
function returnedPaths(name: string, source: string): string[] {
  const declaration = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) return [];
  const open = source.indexOf('{', declaration.index + declaration[0].length);
  if (open === -1) return [];
  const body = source.slice(open, matchingBracket(source, open));
  return [...body.matchAll(/\breturn\b([^;\n]*)/g)].flatMap((match) => pathLiterals(match[1]!));
}

/** Runner paths the target URL expression used at `at` can resolve to. */
function pathsOf(expression: string, source: string, at: number, depth = 0): string[] {
  if (depth > 4) return [];
  const paths = [
    ...pathLiterals(expression),
    ...[...expression.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].flatMap((call) =>
      returnedPaths(call[1]!, source),
    ),
  ];
  if (paths.length) return [...new Set(paths)];
  // A plain identifier or member (`target`, `this.config.execUrl`) derives its
  // path wherever it was assigned.
  const name = expression.includes('(') ? null : /([A-Za-z_$][\w$]*)\s*$/.exec(expression.trim());
  const initializer = name ? declarationOf(name[1]!, source, at) : null;
  return initializer === null ? [] : pathsOf(initializer, source, at, depth + 1);
}

function collectRequestSites(): RequestSite[] {
  const sites: RequestSite[] = [];
  for (const file of CLIENT_FILES) {
    const source = readFileSync(join(API_SERVICES, file), 'utf8');
    for (const { open, parent } of requestBodies(source)) {
      const target = targetExpression(source, open, parent);
      const paths = target === null ? [] : pathsOf(target, source, open);
      for (const path of paths.length ? paths : [BASE_PATH]) {
        sites.push({
          file: `api/src/services/${file}`,
          line: source.slice(0, open).split('\n').length,
          path,
          derived: paths.length > 0,
          keys: topLevelKeys(source, open),
        });
      }
    }
  }
  return sites;
}

// --- what the runner accepts ------------------------------------------------

const RUNNER_SOURCE = readFileSync(RUNNER_APP, 'utf8');
const POST_ROUTE = /@app\.post\(\s*"([^"]+)"\s*\)\s*\ndef\s+\w+\(([^)]*)\)/g;

/** Runner path -> the pydantic model its handler validates the body against. */
function collectRunnerRoutes(): Map<string, string | null> {
  const routes = new Map<string, string | null>();
  for (const match of RUNNER_SOURCE.matchAll(POST_ROUTE)) {
    const model = /\bpayload:\s*(\w+)/.exec(match[2]!);
    routes.set(match[1]!, model ? model[1]! : null);
  }
  return routes;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (QUOTE.test(c)) i = skipLiteral(text, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth === 0;
}

/** Statements of a `class <model>(BaseModel):` body, one per logical line. */
function classStatements(model: string): string[] {
  const header = `class ${model}(BaseModel):`;
  const start = RUNNER_SOURCE.indexOf(header);
  if (start === -1) return [];
  const statements: string[] = [];
  let buffer = '';
  for (const line of RUNNER_SOURCE.slice(start + header.length).split('\n').slice(1)) {
    if (buffer === '') {
      if (line.trim() === '') continue;
      if (!/^\s/.test(line)) break;
      buffer = line.trim();
    } else buffer += ' ' + line.trim();
    if (balanced(buffer)) {
      statements.push(buffer);
      buffer = '';
    }
  }
  return statements;
}

/** Index of the first `=` outside brackets, or -1. */
function assignmentIndex(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (QUOTE.test(c)) i = skipLiteral(text, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '=' && depth === 0) return i;
  }
  return -1;
}

const ANNOTATION = /^([a-z_][\w]*)\s*:\s*(.+)$/;

/** Fields of a pydantic model that a request body must carry. */
function requiredFields(model: string): string[] {
  const required: string[] = [];
  for (const statement of classStatements(model)) {
    const field = ANNOTATION.exec(statement);
    if (!field) continue;
    const assignment = assignmentIndex(field[2]!);
    // A bare annotation has no default at all, so pydantic requires it.
    if (assignment === -1) {
      required.push(field[1]!);
      continue;
    }
    const value = field[2]!.slice(assignment + 1).trim();
    if (!value.startsWith('Field(')) continue;
    if (firstArgument(value, value.indexOf('('))?.trim() === '...') required.push(field[1]!);
  }
  return required;
}

const sites = collectRequestSites();
const routes = collectRunnerRoutes();

describe('runner request contract', () => {
  it('extracts the request bodies and runner models it is meant to compare', () => {
    // A scan that silently matched nothing would pass every other assertion.
    expect(sites.map((site) => site.path).sort()).toEqual([
      '/exec',
      '/exec',
      '/projects/assist',
      '/skills/assist',
      '/skills/generate',
      '/verify',
      '/verify-claude',
    ]);
    expect(sites.find((site) => site.path === '/skills/assist')?.keys).toEqual([
      'auth_json',
      'messages',
      'skill',
      'mode',
      'slug_locked',
      'timeout_seconds',
    ]);
    expect(routes.get('/skills/assist')).toBe('SkillAssistRequest');
    expect(routes.get('/exec')).toBe('ExecRequest');
    expect(requiredFields('SkillAssistRequest')).toEqual(['auth_json', 'messages', 'skill']);
    expect(requiredFields('ExecRequest')).toEqual(['auth_json', 'prompt']);
  });

  it('resolves every request target to a runner path', () => {
    // `verify()` posts to AUTH_RUNNER_URL unchanged; every other target rewrites
    // that URL into a path this scan can read.
    const underived = sites.filter((site) => !site.derived).map((site) => `${site.file}:${site.line}`);
    expect(underived).toHaveLength(1);
    expect(underived[0]).toContain('api/src/services/runner-client.ts');
  });

  it('posts every derived path to a runner route', () => {
    const missing = sites
      .filter((site) => !routes.has(site.path))
      .map((site) => `${site.file}:${site.line} posts to ${site.path}`);
    expect(
      missing,
      'add the @app.post route to runner/app.py, or fix the path the API derives',
    ).toEqual([]);
  });

  it('sends every field the model behind each path requires', () => {
    const omitted = sites.flatMap((site) => {
      const model = routes.get(site.path);
      if (!model) return [];
      return requiredFields(model)
        .filter((field) => !site.keys.includes(field))
        .map((field) => `${site.file}:${site.line} posts to ${site.path} without ${model}.${field}`);
    });
    expect(
      omitted,
      'send the field from the API, or give it a default in runner/app.py',
    ).toEqual([]);
  });
});
