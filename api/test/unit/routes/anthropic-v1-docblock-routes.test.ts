import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstArgument, stripComments } from './registered-routes.js';

/**
 * `anthropic-v1/index.ts` opens with a docblock that presents itself as the
 * module's Anthropic-compat surface — the same header a reader consults for the
 * auth preHandler, the kill switch and the per-key rate bucket. Nothing held it
 * to the `app.route` calls below it, so `messages/count_tokens`, `/complete`
 * and the single-model lookup went live while the header still said they did
 * not exist.
 *
 * This scan reads the `METHOD /path` pairs out of the header comment and out of
 * the registrations in the same file and fails in both directions: a route the
 * comment omits, and a comment line naming a route that is no longer registered.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, '../../../src/routes/anthropic-v1/index.ts');

const source = readFileSync(MODULE, 'utf8');

/** Body of the block comment the module opens with. */
const HEADER = /^\s*\/\*\*([\s\S]*?)\*\//;
/** A `POST    /anthropic/…` line inside it; trailing prose after the path is ignored. */
const DOC_LINE = /^\s*\*\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S+)/gm;
const ROUTE_OBJECT = /\bapp\.route\b/g;
const URL_PROPERTY = /\burl:\s*(['"`])([^'"`]*)\1/;
const METHOD_PROPERTY = /\bmethod:\s*(['"`])([^'"`]*)\1/;

/** `METHOD /path` pairs the header comment names. */
function documentedRoutes(): string[] {
  const header = HEADER.exec(source)?.[1] ?? '';
  const routes = [...header.matchAll(DOC_LINE)].map((line) => `${line[1]!} ${line[2]!}`);
  if (routes.length === 0) {
    throw new Error(`no routes parsed out of the ${MODULE} header comment — the scan is blind`);
  }
  return routes;
}

/** `METHOD /path` pairs the module actually registers. */
function registeredRoutes(): string[] {
  const code = stripComments(source);
  const routes: string[] = [];
  for (const match of code.matchAll(ROUTE_OBJECT)) {
    const options = firstArgument(code, match.index + match[0].length);
    const url = options === null ? null : URL_PROPERTY.exec(options);
    const method = options === null ? null : METHOD_PROPERTY.exec(options);
    if (url && method) routes.push(`${method[2]!.toUpperCase()} ${url[2]!}`);
  }
  if (routes.length === 0) {
    throw new Error(`no registrations parsed out of ${MODULE} — the scan is blind`);
  }
  return routes;
}

const documented = documentedRoutes();
const registered = registeredRoutes();

describe('anthropic-v1 header comment route list', () => {
  it('names every route the module registers', () => {
    const missing = registered.filter((route) => !documented.includes(route));
    expect(missing, 'add these to the route list at the top of the module').toEqual([]);
  });

  it('names no route the module no longer registers', () => {
    const stale = documented.filter((route) => !registered.includes(route));
    expect(stale, 'the registration is gone or renamed — drop it from the header comment').toEqual(
      [],
    );
  });
});
