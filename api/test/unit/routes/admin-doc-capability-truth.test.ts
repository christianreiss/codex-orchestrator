import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `docs/ADMIN.md` and `docs/LOGIN.md` used to document a four-role capability
 * matrix (`admin`/`fleet_operator`/`trusted_user`/`user` mapping to
 * `settings.manage`, `hosts.manage`, `hosts.activate`) and annotated roughly
 * thirty routes with those capability names. None of those strings existed
 * anywhere in `api/src`: `requireAdmin` checks a resolvable session on an
 * active user and nothing else, and the only role gates are the owner/admin
 * checks on admin memories and admin users. Documented authorization that the
 * app does not perform is the worst kind of drift, so this scan holds both docs
 * against the source.
 *
 * A doc fails here when it names a capability token or a role that no file
 * under `api/src` references, or when it stops describing a role the API
 * accepts as an `access_level`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, '../../../../docs');
const API_SRC = resolve(HERE, '../../../src');
const ADMIN_AUTH = join(API_SRC, 'services/admin-auth.ts');

const DOC_NAMES = ['ADMIN.md', 'LOGIN.md'] as const;

/** The section in both docs that describes the role model. */
const ROLES_HEADING = '## Roles & Role Gates';

const CODE_SPAN = /`([^`\n]+)`/g;

/**
 * `<area>.<verb>` with an authorization verb — the grammar the removed matrix
 * used for its capability names. Event names (`auth.retrieve`, `log.created`)
 * and setting keys (`versions.admin_theme`) do not end in one, so the docs keep
 * using them.
 */
const CAPABILITY =
  /^[a-z][a-z0-9_]*\.(?:activate|approve|create|delete|manage|read|update|view|write)$/;

/** A bare lowercase word: how both docs write a role name. */
const ROLE_LIKE = /^[a-z][a-z0-9_]*$/;

interface Span {
  /** 1-based line in the doc, for the failure message. */
  line: number;
  token: string;
}

/** Code spans on lines `[from, until)` (0-based, whole doc by default). */
function codeSpans(markdown: string, from = 0, until = Number.MAX_SAFE_INTEGER): Span[] {
  const spans: Span[] = [];
  for (const [index, text] of markdown.split('\n').entries()) {
    if (index < from || index >= until) continue;
    for (const span of text.matchAll(CODE_SPAN)) {
      spans.push({ line: index + 1, token: span[1]!.trim() });
    }
  }
  return spans;
}

/** Line range of the roles section, from its heading to the next `## `. */
function rolesSection(markdown: string): [number, number] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === ROLES_HEADING);
  if (start === -1) return [-1, -1];
  const offset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  return [start + 1, offset === -1 ? lines.length : start + 1 + offset];
}

function readSourceText(): string {
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) chunks.push(readFileSync(path, 'utf8'));
    }
  };
  walk(API_SRC);
  return chunks.join('\n');
}

const SOURCE = readSourceText();

/** True when some file under `api/src` names `token` as a whole word. */
function referenced(token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(SOURCE);
}

/** The `access_level` values `VALID_ACCESS_LEVELS` accepts, read from source. */
function validAccessLevels(): string[] {
  const source = readFileSync(ADMIN_AUTH, 'utf8');
  const tuple = /export const VALID_ACCESS_LEVELS = \[([^\]]*)\]/.exec(source);
  if (!tuple) throw new Error('no VALID_ACCESS_LEVELS tuple in services/admin-auth.ts');
  return tuple[1]!
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((name) => {
      const literal = new RegExp(`export const ${name} = '([^']+)'`).exec(source);
      if (!literal) throw new Error(`no literal for ${name} in services/admin-auth.ts`);
      return literal[1]!;
    });
}

const docs = DOC_NAMES.map((name) => ({
  name,
  markdown: readFileSync(join(DOCS, name), 'utf8'),
}));
const levels = validAccessLevels();

describe('admin doc role and capability claims', () => {
  it('reads the docs and the source it holds them against', () => {
    // A scan that silently matched nothing would pass every assertion below.
    expect(SOURCE.length).toBeGreaterThan(100_000);
    expect(levels).toContain('owner');
    expect(levels.length).toBeGreaterThanOrEqual(3);
    for (const doc of docs) {
      expect(rolesSection(doc.markdown)[0], `${doc.name} has no ${ROLES_HEADING}`).toBeGreaterThan(
        0,
      );
    }
    // The old matrix, as it was written, is what this scan has to catch.
    const sample = '  - Delete host: `DELETE /admin/hosts/{id}` (`hosts.manage`).';
    expect(codeSpans(sample).map((span) => span.token).filter((t) => CAPABILITY.test(t))).toEqual([
      'hosts.manage',
    ]);
    expect(referenced('hosts.manage')).toBe(false);
    expect(referenced('trusted_user')).toBe(true);
  });

  it('names no capability token the API never references', () => {
    const invented = docs.flatMap((doc) =>
      codeSpans(doc.markdown)
        .filter((span) => CAPABILITY.test(span.token) && !referenced(span.token))
        .map((span) => `docs/${doc.name}:${span.line} documents capability ${span.token}`),
    );
    expect(
      invented,
      'the Node API has no capability system; document the role gate that exists instead',
    ).toEqual([]);
  });

  it('names no role the API never references', () => {
    const invented = docs.flatMap((doc) => {
      const [from, until] = rolesSection(doc.markdown);
      return codeSpans(doc.markdown, from, until)
        .filter((span) => ROLE_LIKE.test(span.token) && !referenced(span.token))
        .map((span) => `docs/${doc.name}:${span.line} documents ${span.token}`);
    });
    expect(invented, `no file under api/src names these`).toEqual([]);
  });

  it('describes every role VALID_ACCESS_LEVELS accepts', () => {
    const missing = docs.flatMap((doc) => {
      const [from, until] = rolesSection(doc.markdown);
      const documented = new Set(codeSpans(doc.markdown, from, until).map((span) => span.token));
      return levels
        .filter((level) => !documented.has(level))
        .map((level) => `docs/${doc.name} never mentions the ${level} role`);
    });
    expect(missing, `list it under ${ROLES_HEADING}`).toEqual([]);
  });
});
