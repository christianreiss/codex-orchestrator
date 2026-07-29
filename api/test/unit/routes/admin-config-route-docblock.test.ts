import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  firstArgument,
  skipTypeArguments,
  stripComments,
  STRING_LITERAL,
} from './registered-routes.js';

/**
 * `admin/config/index.ts` opens with a "Routes registered:" block that claims to
 * enumerate its own registrations. It is hand-maintained and nothing held it to
 * the `app.get/post/delete` calls below it, so the three `/admin/claude/config`
 * routes added later never reached the list and the module's map of itself went
 * stale unnoticed.
 *
 * This scan reads the `METHOD /path` pairs out of the header comment and out of
 * the registrations in the same file and fails in both directions: a route the
 * comment omits, and a comment line naming a route that is no longer registered.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = resolve(HERE, '../../../src/routes/admin/config/index.ts');

const source = readFileSync(MODULE, 'utf8');

/** Body of the block comment the module opens with. */
const HEADER = /^\s*\/\*\*([\s\S]*?)\*\//;
/** A `GET    /admin/…` line inside it; trailing prose after the path is ignored. */
const DOC_LINE = /^\s*\*\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S+)/gm;
const REGISTRAR = /\bapp\.(get|post|put|patch|delete|options)\b/g;

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
  for (const match of code.matchAll(REGISTRAR)) {
    const open = skipTypeArguments(code, match.index + match[0].length);
    if (code[open] !== '(') continue;
    const literal = STRING_LITERAL.exec((firstArgument(code, open) ?? '').trim());
    if (!literal || !literal[2]!.startsWith('/admin')) continue;
    routes.push(`${match[1]!.toUpperCase()} ${literal[2]!}`);
  }
  if (routes.length === 0) {
    throw new Error(`no registrations parsed out of ${MODULE} — the scan is blind`);
  }
  return routes;
}

const documented = documentedRoutes();
const registered = registeredRoutes();

describe('admin/config header comment route list', () => {
  it('names every route the module registers', () => {
    const missing = registered.filter((route) => !documented.includes(route));
    expect(missing, 'add these to the "Routes registered:" block at the top of the module').toEqual(
      [],
    );
  });

  it('names no route the module no longer registers', () => {
    const stale = documented.filter((route) => !registered.includes(route));
    expect(stale, 'the registration is gone or renamed — drop it from the header comment').toEqual(
      [],
    );
  });
});
