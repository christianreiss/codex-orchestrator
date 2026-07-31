import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MANAGED_AFK_SKILL_SLUG } from '../../../src/services/managed-afk-skill.js';
import { MANAGED_COCO_SKILL_SLUG } from '../../../src/services/managed-coco-skill.js';
import { MANAGED_CONTEXT_SKILL_SLUG } from '../../../src/services/managed-context-skill.js';
import { MANAGED_SKILL_MANAGER_SLUG } from '../../../src/services/managed-skill-manager.js';
import { isManagedSkillSlug } from '../../../src/services/managed-skills.js';
import { collectRegisteredRoutes } from '../routes/registered-routes.js';

/**
 * `docs/skills/README.md` is the only prose that tells an operator which slugs
 * are code-managed, and every claim in it is load-bearing: which slugs the
 * store endpoint rejects, which modules hold their manifests, and that a
 * checked-in `*.SKILL.md` is always a stored-row artifact. Nothing checked any
 * of it. A third managed slug, a renamed constant or a moved module would leave
 * the file quietly wrong — the exact drift the file itself warns about.
 *
 * So this holds the doc against the registry in both directions, the same way
 * the OVERVIEW/USAGE/MCP liveness scans hold their docs against the code.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const DOCS_SKILLS = resolve(ROOT, 'docs/skills');
const DOC = resolve(DOCS_SKILLS, 'README.md');

/** The section that carries the managed-slug claim, up to the next heading. */
const SECTION = '## Managed skills (code-derived, never stored)';
/**
 * The section opens by naming the managed slugs — "`coco` and `context` are NOT
 * rows in the `skills` table" — so the claim is everything before this marker.
 * Scanning the whole section instead would read `skills`, `/skills` and
 * `projects_module_enabled = 1` as slugs.
 */
const SLUG_CLAIM_END = 'are NOT rows in the';

/** A backticked code span. */
const SPAN = /`([^`]+)`/g;
/** An `api/src/services/*.ts` module path, wherever in the doc it is cited. */
const SERVICE_PATH = /api\/src\/services\/[A-Za-z0-9._-]+\.ts/g;
/** A backticked `METHOD /path` the doc tells an operator to call. */
const ROUTE = /`(GET|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9/_:-]+)`/g;

/** Slug shape, so a reworded claim sentence fails loudly instead of silently. */
const SLUG = /^[a-z][a-z0-9-]*$/;

/** A slug of ordinary authored shape that code does not and will not own. */
const AUTHORED_SLUG = 'deploy-runbook';

/**
 * Deliberate deltas between the doc's managed-slug list and the registry, with
 * the reason each one is one-sided. Empty on purpose: a delta today is drift,
 * and the fix is to correct whichever side is wrong, not to record it here.
 */
const ALLOWED_SLUG_DELTAS: Record<string, string> = {};

const doc = readFileSync(DOC, 'utf8');

const managedSlugs = [
  MANAGED_AFK_SKILL_SLUG,
  MANAGED_COCO_SKILL_SLUG,
  MANAGED_CONTEXT_SKILL_SLUG,
  MANAGED_SKILL_MANAGER_SLUG,
];

/** The slugs the section's opening claim names as managed. */
function documentedManagedSlugs(): string[] {
  const heading = doc.indexOf(SECTION);
  if (heading < 0) throw new Error(`docs/skills/README.md has no "${SECTION}" section`);
  const rest = doc.slice(heading + SECTION.length);
  const next = rest.indexOf('\n## ');
  const section = next < 0 ? rest : rest.slice(0, next);
  const marker = section.indexOf(SLUG_CLAIM_END);
  if (marker < 0) throw new Error(`the managed-skills section no longer claims "${SLUG_CLAIM_END}"`);
  return [...section.slice(0, marker).matchAll(SPAN)].map((span) => span[1]!);
}

/** Slug of a checked-in manifest: the filename, and the `name:` its front matter declares. */
function skillFileSlugs(file: string): string[] {
  const fromName = file.slice(0, -'.SKILL.md'.length).toLowerCase();
  const declared = /^name:\s*(\S+)\s*$/m.exec(readFileSync(resolve(DOCS_SKILLS, file), 'utf8'));
  return declared ? [fromName, declared[1]!.toLowerCase()] : [fromName];
}

describe('docs/skills/README.md managed-skill claims', () => {
  it('extracts the claims it is meant to check', () => {
    // A scan that quietly stopped matching would pass every assertion below.
    const documented = documentedManagedSlugs();
    expect(documented.length).toBeGreaterThan(0);
    for (const slug of documented) expect(slug).toMatch(SLUG);
    // The `skills` table and `POST /admin/skills/store` sit after the marker.
    expect(documented).not.toContain('skills');

    expect([...doc.matchAll(SERVICE_PATH)].map((match) => match[0])).toContain(
      'api/src/services/managed-skills.ts',
    );
    expect([...doc.matchAll(ROUTE)].map((match) => match[2])).toContain('/admin/skills/store');
  });

  it('names exactly the slugs the managed-skill registry owns', () => {
    const documented = new Set(documentedManagedSlugs());

    const undocumented = managedSlugs.filter(
      (slug) => !documented.has(slug) && !(slug in ALLOWED_SLUG_DELTAS),
    );
    expect(
      undocumented,
      'api/src/services/managed-skills.ts owns these slugs, but the "Managed skills" section of ' +
        'docs/skills/README.md does not name them — an operator reading the doc would try to ' +
        'store one through POST /admin/skills/store',
    ).toEqual([]);

    const stale = [...documented].filter(
      (slug) => !managedSlugs.includes(slug) && !(slug in ALLOWED_SLUG_DELTAS),
    );
    expect(
      stale,
      'docs/skills/README.md calls these slugs code-managed, but isManagedSkillSlug does not own ' +
        'them — they are ordinary stored rows now, and the doc forbids storing them',
    ).toEqual([]);
  });

  it('agrees with isManagedSkillSlug on each documented slug', () => {
    for (const slug of documentedManagedSlugs()) {
      expect(isManagedSkillSlug(slug), `${slug} is documented as managed`).toBe(true);
    }
    expect(isManagedSkillSlug(AUTHORED_SLUG)).toBe(false);
  });

  it('cites only api/src/services modules that exist', () => {
    const cited = [...new Set([...doc.matchAll(SERVICE_PATH)].map((match) => match[0]))];
    const missing = cited.filter((path) => !existsSync(resolve(ROOT, path)));
    expect(missing, 'docs/skills/README.md points at modules that have moved or been renamed').toEqual([]);
  });

  it('cites only routes the API registers', () => {
    const registered = collectRegisteredRoutes();
    const cited = [...doc.matchAll(ROUTE)].map((match) => `${match[1]} ${match[2]}`);
    const dead = [...new Set(cited)].filter(
      (route) => !registered.some(({ method, path }) => `${method} ${path}` === route),
    );
    expect(dead, 'docs/skills/README.md tells operators to call routes api/src/routes does not serve').toEqual([]);
  });

  it('keeps every checked-in manifest a stored-row artifact', () => {
    const files = readdirSync(DOCS_SKILLS).filter((file) => file.endsWith('.SKILL.md'));
    const managed = files.filter((file) => skillFileSlugs(file).some(isManagedSkillSlug));
    expect(
      managed,
      'a managed skill is synthesized from code and cannot be stored, so a file for it here ships ' +
        'nothing and can only drift — delete it, or drop the slug from the managed registry',
    ).toEqual([]);
  });

  it('keeps the delta allowlist honest', () => {
    const documented = new Set(documentedManagedSlugs());
    for (const [slug, reason] of Object.entries(ALLOWED_SLUG_DELTAS)) {
      expect(
        documented.has(slug) !== managedSlugs.includes(slug),
        `${slug} is no longer a delta between the doc and the registry — drop it`,
      ).toBe(true);
      expect(reason.trim()).not.toBe('');
    }
  });
});
