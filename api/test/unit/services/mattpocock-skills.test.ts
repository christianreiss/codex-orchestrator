import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillFiles, skills, versions } from '../../../src/db/schema.js';
import {
  MATTPOCOCK_SOURCE_TYPE,
  MATTPOCOCK_STATE_KEY,
  MattPocockSkillsService,
} from '../../../src/services/mattpocock-skills.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';

const REVISION = 'a'.repeat(40);
const NOW = new Date('2026-07-29T12:00:00.000Z');
const API = 'https://api.github.com/repos/mattpocock/skills';
const RAW = `https://raw.githubusercontent.com/mattpocock/skills/${REVISION}`;

interface FixtureOptions {
  pluginSkills?: unknown[];
  truncated?: boolean;
  treeMutator?: (tree: TreeEntry[]) => void;
  rawMutator?: (files: Map<string, string>) => void;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface FetchFixture {
  fetch: typeof globalThis.fetch;
  calls: string[];
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function blob(path: string, content: string, mode = '100644'): TreeEntry {
  return { path, mode, type: 'blob', sha: gitBlobSha(content), size: Buffer.byteLength(content) };
}

function tree(path: string): TreeEntry {
  return { path, mode: '040000', type: 'tree', sha: 'b'.repeat(40) };
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  });
}

function textResponse(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(value)) },
  });
}

function fixture(options: FixtureOptions = {}): FetchFixture {
  const tdd = [
    '---',
    'name: tdd',
    'description: "Test-driven development: red, green, refactor."',
    '---',
    '',
    '# TDD',
    '',
    'Read [tests](tests.md).',
    '',
  ].join('\n');
  const grill = [
    '---',
    'name: grill-me',
    "description: 'Interview the user until the plan is clear.'",
    'disable-model-invocation: true',
    '---',
    '',
    '# Grill me',
    '',
  ].join('\n');
  const openai = [
    'interface:',
    '  display_name: "TDD"',
    '  short_description: "Red-green development"',
    '',
  ].join('\n');
  const tests = '# Tests\n\nTest behavior, not implementation.\n';
  const excluded = '---\nname: private-note\ndescription: Never publish this.\n---\n';
  const license = 'MIT License\n\nCopyright (c) 2026 Matt Pocock\n\nPermission is hereby granted.\n';
  const plugin = JSON.stringify({
    name: 'mattpocock-skills',
    version: '1.2.0',
    skills: options.pluginSkills ?? ['./skills/engineering/tdd', './skills/productivity/grill-me'],
  });

  const raw = new Map<string, string>([
    ['.claude-plugin/plugin.json', plugin],
    ['LICENSE', license],
    ['skills/engineering/tdd/SKILL.md', tdd],
    ['skills/engineering/tdd/agents/openai.yaml', openai],
    ['skills/engineering/tdd/tests.md', tests],
    ['skills/productivity/grill-me/SKILL.md', grill],
    ['skills/personal/private-note/SKILL.md', excluded],
  ]);
  options.rawMutator?.(raw);
  const entries: TreeEntry[] = [
    blob('.claude-plugin/plugin.json', raw.get('.claude-plugin/plugin.json')!),
    blob('LICENSE', raw.get('LICENSE')!),
    tree('skills/engineering/tdd'),
    blob('skills/engineering/tdd/SKILL.md', raw.get('skills/engineering/tdd/SKILL.md')!),
    tree('skills/engineering/tdd/agents'),
    blob('skills/engineering/tdd/agents/openai.yaml', raw.get('skills/engineering/tdd/agents/openai.yaml')!),
    blob('skills/engineering/tdd/tests.md', raw.get('skills/engineering/tdd/tests.md')!),
    tree('skills/productivity/grill-me'),
    blob('skills/productivity/grill-me/SKILL.md', raw.get('skills/productivity/grill-me/SKILL.md')!),
    tree('skills/personal/private-note'),
    blob('skills/personal/private-note/SKILL.md', raw.get('skills/personal/private-note/SKILL.md')!),
  ];
  options.treeMutator?.(entries);

  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === `${API}/commits/main`) return jsonResponse({ sha: REVISION });
    if (url === `${API}/git/trees/${REVISION}?recursive=1`) {
      return jsonResponse({ truncated: options.truncated ?? false, tree: entries });
    }
    if (url.startsWith(`${RAW}/`)) {
      const path = url.slice(`${RAW}/`.length).split('/').map(decodeURIComponent).join('/');
      const content = raw.get(path);
      if (content !== undefined) return textResponse(content);
    }
    return new Response('missing', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function database(initial: Map<unknown, Record<string, unknown>[]> = new Map()): DbFake {
  const db = createDbFake(initial);
  if (!db.tables.has(skills)) db.tables.set(skills, []);
  if (!db.tables.has(skillFiles)) db.tables.set(skillFiles, []);
  if (!db.tables.has(versions)) db.tables.set(versions, []);
  return db;
}

function service(db: DbFake, upstream: FetchFixture, timeoutMs = 1_000): MattPocockSkillsService {
  return new MattPocockSkillsService(db as never, {
    fetch: upstream.fetch,
    clock: () => new Date(NOW),
    timeoutMs,
  });
}

function rows(db: DbFake, table: unknown): Record<string, unknown>[] {
  return db.tables.get(table) ?? [];
}

function sourceState(db: DbFake): Record<string, unknown> {
  const row = rows(db, versions).find((candidate) => candidate.name === MATTPOCOCK_STATE_KEY);
  return JSON.parse(String(row?.version ?? '{}')) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MattPocockSkillsService state and controls', () => {
  it('defaults disabled with auto-update primed for first enable', async () => {
    const db = database();
    const upstream = fixture();
    await expect(service(db, upstream).getState()).resolves.toEqual({
      source: 'github:mattpocock/skills',
      repository: 'https://github.com/mattpocock/skills',
      ref: 'main',
      enabled: false,
      auto_update: true,
      status: 'disabled',
      revision: null,
      upstream_version: null,
      skill_count: 0,
      file_count: 0,
      last_checked_at: null,
      last_synced_at: null,
      last_error: null,
    });
    expect(upstream.calls).toEqual([]);
  });

  it('keeps forced refresh a strict no-op while disabled', async () => {
    const db = database();
    const upstream = fixture();
    const state = await service(db, upstream).refresh({ force: true });
    expect(state.status).toBe('disabled');
    expect(upstream.calls).toEqual([]);
    expect(rows(db, versions)).toEqual([]);
  });

  it('preserves an explicit auto-update preference across first enable', async () => {
    const db = database();
    const upstream = fixture();
    const state = await service(db, upstream).configure({ auto_update: false, enabled: true });
    expect(state).toMatchObject({ enabled: true, auto_update: false, status: 'ok' });
  });
});

describe('MattPocockSkillsService upstream promotion', () => {
  it('imports only the promoted plugin allowlist with complete files, provenance, license and one event pair', async () => {
    const db = database();
    const upstream = fixture();
    const events: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = wsPublisher.subscribe((event) => {
      if (event.type === 'skill.updated' || event.type === 'settings.changed') {
        events.push({ type: event.type, payload: event.payload });
      }
    });
    try {
      const state = await service(db, upstream).configure({ enabled: true });
      expect(state).toMatchObject({
        enabled: true,
        auto_update: true,
        status: 'ok',
        revision: REVISION,
        upstream_version: '1.2.0',
        skill_count: 2,
        // Four selected source files plus a copied license in each skill.
        file_count: 6,
        last_error: null,
      });

      const skillRows = rows(db, skills);
      expect(skillRows.map((row) => row.slug).sort()).toEqual(['grill-me', 'tdd']);
      for (const row of skillRows) {
        expect(row).toMatchObject({
          sourceType: MATTPOCOCK_SOURCE_TYPE,
          sourceRepository: 'https://github.com/mattpocock/skills',
          sourceRevision: REVISION,
          sourceLicense: 'MIT',
          deletedAt: null,
          engine: null,
        });
        expect(row.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(skillRows.find((row) => row.slug === 'tdd')).toMatchObject({
        sourcePath: 'skills/engineering/tdd',
        displayName: 'tdd',
        description: 'Test-driven development: red, green, refactor.',
      });

      const files = rows(db, skillFiles);
      expect(files).toHaveLength(4);
      expect(files.map((file) => file.path).sort()).toEqual([
        'LICENSE.mattpocock',
        'LICENSE.mattpocock',
        'agents/openai.yaml',
        'tests.md',
      ]);
      expect(files.filter((file) => file.path === 'LICENSE.mattpocock')).toHaveLength(2);
      expect(files.find((file) => file.path === 'agents/openai.yaml')?.content).toContain(
        'display_name: "TDD"',
      );
      expect(upstream.calls.some((url) => url.includes('skills/personal/private-note'))).toBe(false);
      expect(sourceState(db)).toMatchObject({ enabled: true, revision: REVISION, file_count: 6 });
      expect(events).toEqual([
        {
          type: 'skill.updated',
          payload: { source: MATTPOCOCK_SOURCE_TYPE, revision: REVISION, enabled: true },
        },
        { type: 'settings.changed', payload: { key: MATTPOCOCK_STATE_KEY } },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('soft-deletes source-owned rows on disable while retaining cached files and revision', async () => {
    const db = database();
    const upstream = fixture();
    const importer = service(db, upstream);
    await importer.configure({ enabled: true });
    const fileSnapshot = rows(db, skillFiles).map((row) => ({ ...row }));

    const events: string[] = [];
    const unsubscribe = wsPublisher.subscribe((event) => {
      if (event.type === 'skill.updated' || event.type === 'settings.changed') events.push(event.type);
    });
    try {
      const state = await importer.configure({ enabled: false });
      expect(state).toMatchObject({
        enabled: false,
        status: 'disabled',
        revision: REVISION,
        skill_count: 2,
        file_count: 6,
      });
      expect(rows(db, skills).every((row) => row.deletedAt === NOW.toISOString())).toBe(true);
      expect(rows(db, skillFiles)).toEqual(fileSnapshot);
      expect(events).toEqual(['skill.updated', 'settings.changed']);
    } finally {
      unsubscribe();
    }
  });

  it('restores a complete cached LKG on re-enable without GitHub access', async () => {
    const db = database();
    const upstream = fixture();
    const importer = service(db, upstream);
    await importer.configure({ enabled: true });
    await importer.configure({ enabled: false, auto_update: false });
    upstream.calls.length = 0;

    const restored = await importer.configure({ enabled: true });

    expect(restored).toMatchObject({ enabled: true, auto_update: false, status: 'ok', revision: REVISION });
    expect(upstream.calls).toEqual([]);
    expect(rows(db, skills).filter((row) => row.sourceRevision === REVISION).every((row) => row.deletedAt === null)).toBe(true);
    expect(db.locks.some((lock) => lock.table === versions && lock.strength === 'update')).toBe(true);
  });

  it('skips the bundle download when the immutable revision is unchanged', async () => {
    const db = database();
    const upstream = fixture();
    const importer = service(db, upstream);
    await importer.configure({ enabled: true });
    upstream.calls.length = 0;

    const state = await importer.refresh();
    expect(state.revision).toBe(REVISION);
    expect(upstream.calls).toEqual([`${API}/commits/main`]);
  });

  it('rebuilds a damaged cached bundle even when the upstream revision is unchanged', async () => {
    const db = database();
    const upstream = fixture();
    const importer = service(db, upstream);
    await importer.configure({ enabled: true });
    const damaged = rows(db, skillFiles)[0]!;
    damaged.content = 'tampered after import';
    upstream.calls.length = 0;

    const refreshed = await importer.refresh();

    expect(refreshed).toMatchObject({ status: 'ok', revision: REVISION, last_error: null });
    expect(upstream.calls).toContain(`${API}/git/trees/${REVISION}?recursive=1`);
    expect(rows(db, skillFiles).some((file) => file.content === 'tampered after import')).toBe(false);
  });

  it('serializes refreshes across independently constructed service instances', async () => {
    const db = database();
    const upstream = fixture();
    const baseFetch = upstream.fetch;
    let active = 0;
    let maxActive = 0;
    const delayed = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== `${API}/commits/main`) return await baseFetch(input, init);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await baseFetch(input, init);
      } finally {
        active -= 1;
      }
    }) as unknown as typeof globalThis.fetch;
    const first = new MattPocockSkillsService(db as never, {
      fetch: delayed,
      clock: () => new Date(NOW),
      timeoutMs: 1_000,
    });
    const second = new MattPocockSkillsService(db as never, {
      fetch: delayed,
      clock: () => new Date(NOW),
      timeoutMs: 1_000,
    });
    await first.configure({ enabled: true });

    await Promise.all([first.refresh({ force: true }), second.refresh({ force: true })]);
    expect(maxActive).toBe(1);
  });
});

describe('MattPocockSkillsService validation and last-known-good behavior', () => {
  it.each([
    ['./skills/in-progress/wizard', 'outside promoted skill buckets'],
    ['./skills/engineering/tdd/child', 'outside promoted skill buckets'],
    ['./skills/engineering/../productivity/grill-me', 'outside promoted skill buckets'],
  ])('rejects unsafe or non-promoted allowlist path %s', async (path, message) => {
    const db = database();
    const upstream = fixture({ pluginSkills: [path] });
    await expect(service(db, upstream).configure({ enabled: true })).rejects.toThrow(message);
    expect(rows(db, skills)).toEqual([]);
    expect(sourceState(db)).toMatchObject({ enabled: false, status: 'error', revision: null });
  });

  it('rejects duplicate slugs before promotion', async () => {
    const db = database();
    const upstream = fixture({
      pluginSkills: ['./skills/engineering/tdd', './skills/productivity/tdd'],
    });
    await expect(service(db, upstream).configure({ enabled: true })).rejects.toThrow(
      'repeats skill slug: tdd',
    );
    expect(rows(db, skills)).toEqual([]);
  });

  it('rejects truncated trees and selected symlinks', async () => {
    const truncated = fixture({ truncated: true });
    await expect(service(database(), truncated).configure({ enabled: true })).rejects.toThrow('truncated');

    const symlink = fixture({
      treeMutator: (entries) => {
        entries.push({
          path: 'skills/engineering/tdd/escape',
          mode: '120000',
          type: 'blob',
          sha: 'c'.repeat(40),
          size: 6,
        });
      },
    });
    await expect(service(database(), symlink).configure({ enabled: true })).rejects.toThrow(
      'symlink or non-blob',
    );
  });

  it('rejects descendants beneath the injected license path regardless of case', async () => {
    const reservedDescendant = '# must not land beneath the injected license\n';
    const db = database();
    const upstream = fixture({
      rawMutator: (files) => {
        files.set('skills/engineering/tdd/LICENSE.MATTPOCOCK/notice.md', reservedDescendant);
      },
      treeMutator: (entries) => {
        entries.push(
          tree('skills/engineering/tdd/LICENSE.MATTPOCOCK'),
          blob('skills/engineering/tdd/LICENSE.MATTPOCOCK/notice.md', reservedDescendant),
        );
      },
    });

    await expect(service(db, upstream).configure({ enabled: true })).rejects.toThrow(
      'reserved bundle path',
    );
    expect(rows(db, skills)).toEqual([]);
    expect(rows(db, skillFiles)).toEqual([]);
  });

  it('rejects file-versus-directory prefix collisions in delivered paths', async () => {
    const parent = '# parent file\n';
    const child = '# child file\n';
    const db = database();
    const upstream = fixture({
      rawMutator: (files) => {
        files.set('skills/engineering/tdd/guide', parent);
        files.set('skills/engineering/tdd/guide/details.md', child);
      },
      treeMutator: (entries) => {
        entries.push(
          blob('skills/engineering/tdd/guide', parent),
          blob('skills/engineering/tdd/guide/details.md', child),
        );
      },
    });

    await expect(service(db, upstream).configure({ enabled: true })).rejects.toThrow(
      'file/directory bundle path collision',
    );
    expect(rows(db, skills)).toEqual([]);
    expect(rows(db, skillFiles)).toEqual([]);
  });

  it('rejects a missing MIT notice and any blob that disagrees with the immutable Git tree', async () => {
    const wrongLicense = fixture({
      rawMutator: (files) => files.set('LICENSE', 'A proprietary license\n'),
    });
    await expect(service(database(), wrongLicense).configure({ enabled: true })).rejects.toThrow(
      'not the expected MIT license',
    );

    const mismatchedBlob = fixture({
      treeMutator: (entries) => {
        const tests = entries.find((entry) => entry.path.endsWith('/tests.md'))!;
        tests.sha = 'f'.repeat(40);
      },
    });
    await expect(service(database(), mismatchedBlob).configure({ enabled: true })).rejects.toThrow(
      'does not match Git tree SHA',
    );
  });

  it('rejects a fleet-owned slug collision without mutating the last-known-good row', async () => {
    const local = {
      id: 7,
      slug: 'tdd',
      sha256: 'd'.repeat(64),
      displayName: 'Fleet TDD',
      description: 'Local',
      manifest: '# local',
      sourceHostId: null,
      sourceType: null,
      sourceRepository: null,
      sourcePath: null,
      sourceRevision: null,
      sourceLicense: null,
      bundleSha256: null,
      createdAt: 'before',
      updatedAt: 'before',
      deletedAt: null,
      engine: null,
    };
    const db = database(new Map([[skills, [local]]]));
    const upstream = fixture();
    await expect(service(db, upstream).configure({ enabled: true })).rejects.toThrow(
      'collides with fleet-owned skill: tdd',
    );
    expect(rows(db, skills)).toEqual([local]);
    expect(rows(db, skillFiles)).toEqual([]);
    expect(sourceState(db)).toMatchObject({ enabled: false, status: 'error', revision: null });
  });

  it('rejects a code-managed slug collision before promotion', async () => {
    const managedManifest = [
      '---',
      'name: context',
      'description: Must not shadow the fleet-managed context skill.',
      '---',
      '',
    ].join('\n');
    const db = database();
    const upstream = fixture({
      pluginSkills: ['./skills/productivity/context'],
      rawMutator: (files) => {
        files.set('skills/productivity/context/SKILL.md', managedManifest);
      },
      treeMutator: (entries) => {
        entries.push(
          tree('skills/productivity/context'),
          blob('skills/productivity/context/SKILL.md', managedManifest),
        );
      },
    });
    await expect(service(db, upstream).configure({ enabled: true })).rejects.toThrow(
      'collides with code-managed skill: context',
    );
    expect(rows(db, skills)).toEqual([]);
    expect(rows(db, skillFiles)).toEqual([]);
    expect(sourceState(db)).toMatchObject({ enabled: false, status: 'error', revision: null });
  });

  it('retains the complete live last-known-good snapshot when a later refresh fails', async () => {
    const db = database();
    const good = fixture();
    await service(db, good).configure({ enabled: true });
    const skillSnapshot = rows(db, skills).map((row) => ({ ...row }));
    const fileSnapshot = rows(db, skillFiles).map((row) => ({ ...row }));

    const bad = fixture({ truncated: true });
    await expect(service(db, bad).refresh({ force: true })).rejects.toThrow('truncated');
    expect(rows(db, skills)).toEqual(skillSnapshot);
    expect(rows(db, skillFiles)).toEqual(fileSnapshot);
    expect(sourceState(db)).toMatchObject({
      enabled: true,
      status: 'error',
      revision: REVISION,
      skill_count: 2,
      file_count: 6,
    });
  });

  it('records timeout failure while leaving the source disabled', async () => {
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof globalThis.fetch;
    const db = database();
    const importer = new MattPocockSkillsService(db as never, {
      fetch: hanging,
      clock: () => new Date(NOW),
      timeoutMs: 5,
    });
    await expect(importer.configure({ enabled: true })).rejects.toThrow('timed out');
    expect(sourceState(db)).toMatchObject({ enabled: false, status: 'error' });
    expect(String(sourceState(db).last_error)).toContain('timed out');
  });
});
