/**
 * `#context` is derived from code, not stored as a `skills` row.
 *
 * The failure this guards against is silent: if the manifest stops naming the
 * MCP tools, or a DB row starts shadowing the code version, agents keep working
 * and simply stop using the orchestrator's memory. Nothing goes red. These
 * assertions are the only thing that notices.
 */
import { describe, it, expect } from 'vitest';
import { skills as skillsTable, versions as versionsTable } from '../../../src/db/schema.js';
import { HostSkillsService } from '../../../src/services/host-skills.js';
import {
  MANAGED_CONTEXT_SKILL_SLUG,
  buildManagedContextSkill,
  isManagedContextSlug,
  managedContextManifest,
} from '../../../src/services/managed-context-skill.js';
import { findManagedSkill, isManagedSkillSlug, listManagedSkills } from '../../../src/services/managed-skills.js';
import { MCP_TOOL_NAMES } from '../../../src/services/shared-memory-tool-names.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import type { Host } from '../../../src/db/schema.js';

const host: Host = { id: 1, fqdn: 'vm.example' } as unknown as Host;

function makeDb(opts: { projectsEnabled?: boolean; rows?: Array<Record<string, unknown>> } = {}): DbFake {
  const db = createDbFake();
  db.tables.set(versionsTable, opts.projectsEnabled ? [{ name: 'projects_module_enabled', version: '1', updatedAt: 't' }] : []);
  db.tables.set(skillsTable, opts.rows ?? []);
  return db;
}

describe('managed #context skill', () => {
  it('names every MCP memory tool it tells agents to call', () => {
    const manifest = managedContextManifest();
    for (const tool of Object.values(MCP_TOOL_NAMES)) {
      expect(manifest).toContain(tool);
    }
    expect(manifest).toContain('project_memory_upsert');
    expect(manifest).toContain('project_bootstrap');
  });

  // The whole reason the skill exists: Claude Code's native file memory wins by
  // default, so the manifest has to name it and override it outright.
  it('overrides Claude Code’s native file memory by name', () => {
    const manifest = managedContextManifest();
    expect(manifest).toContain('~/.claude/projects');
    expect(manifest).toContain('MEMORY.md');
    expect(manifest).toMatch(/do not mirror/i);
    expect(manifest).toMatch(/host-local/i);
  });

  it('tells agents the listing tools need no query', () => {
    expect(managedContextManifest()).toMatch(/needs no query/i);
  });

  it('carries valid frontmatter with the slug as name', () => {
    const manifest = managedContextManifest();
    expect(manifest.startsWith('---\n')).toBe(true);
    expect(manifest).toContain(`name: ${MANAGED_CONTEXT_SKILL_SLUG}`);
    expect(manifest).toMatch(/^description: "/m);
  });

  it('derives a stable sha from the manifest text', () => {
    const a = buildManagedContextSkill('t');
    const b = buildManagedContextSkill('t');
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.managed).toBe(true);
    expect(a.uri).toBe('skill://context');
  });

  it('recognises its slug case-insensitively', () => {
    expect(isManagedContextSlug('Context')).toBe(true);
    expect(isManagedContextSlug(' context ')).toBe(true);
    expect(isManagedContextSlug('contexts')).toBe(false);
    expect(isManagedSkillSlug('context')).toBe(true);
    expect(isManagedSkillSlug('coco')).toBe(true);
    expect(isManagedSkillSlug('git-commit')).toBe(false);
  });
});

describe('managed skill registry', () => {
  it('serves context unconditionally and coco only when Projects is on', async () => {
    const off = await listManagedSkills(makeDb() as never);
    expect(off.map((s) => s.slug)).toEqual(['context']);

    const on = await listManagedSkills(makeDb({ projectsEnabled: true }) as never);
    expect(on.map((s) => s.slug)).toEqual(['coco', 'context']);
  });

  it('resolves a managed skill by slug and ignores unmanaged ones', async () => {
    const db = makeDb() as never;
    expect(await findManagedSkill(db, 'context')).not.toBeNull();
    expect(await findManagedSkill(db, 'git-commit')).toBeNull();
    // coco is managed but not served while Projects is off.
    expect(await findManagedSkill(db, 'coco')).toBeNull();
  });
});

describe('host skill surface', () => {
  const dbRow = {
    id: 9,
    slug: 'context',
    displayName: 'Stale DB copy',
    description: 'stale',
    manifest: 'THIS IS THE STALE DATABASE VERSION',
    sha256: 'a'.repeat(64),
    engine: null,
    deletedAt: null,
    createdAt: 't',
    updatedAt: 't',
  };

  // The exact drift that motivated this: a `context` row seeded by hand months
  // ago kept being served while the repo copy moved on. The code version must
  // win, and the row must not also appear as a duplicate entry.
  it('shadows a stale database row of the same slug', async () => {
    const svc = new HostSkillsService(makeDb({ rows: [dbRow] }) as never);
    const listed = await svc.listSkills(host, null);
    const contexts = listed.skills.filter((s) => s['slug'] === 'context');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!['managed']).toBe(true);

    const retrieved = await svc.retrieve('context', null, host);
    expect(retrieved['managed']).toBe(true);
    expect(String(retrieved['manifest'])).not.toContain('STALE DATABASE VERSION');
    expect(String(retrieved['manifest'])).toContain(MCP_TOOL_NAMES.sharedList);
  });

  it('bundles context to Claude hosts on disk, shadowing the row', async () => {
    const svc = new HostSkillsService(makeDb({ rows: [dbRow] }) as never);
    const bundled = await svc.bundle(host, 'claude');
    const entries = bundled.filter((b) => b.slug === 'context');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('updated');
    expect(entries[0]!.content).toContain(MCP_TOOL_NAMES.sharedSearch);
  });

  it('reports unchanged when the host already holds the current manifest', async () => {
    const svc = new HostSkillsService(makeDb() as never);
    const sha = buildManagedContextSkill('t').sha256;
    const bundled = await svc.bundle(host, 'claude', { context: sha });
    expect(bundled.find((b) => b.slug === 'context')!.status).toBe('unchanged');

    const retrieved = await svc.retrieve('context', sha, host);
    expect(retrieved['status']).toBe('unchanged');
    expect(retrieved).not.toHaveProperty('manifest');
  });

  it('is served to codex hosts too — the skill is engine-agnostic', async () => {
    const svc = new HostSkillsService(makeDb() as never);
    const listed = await svc.listSkills(host, 'codex');
    expect(listed.skills.some((s) => s['slug'] === 'context')).toBe(true);
  });
});
