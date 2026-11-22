import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import { OwnerStateSnapshot, OwnerStateStore, type PreparedOwnerState } from '../../../src/control-plane/state/store.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { scopedDatabase } from '../../../src/db/fresh-read.js';
import { ProjectChangelogService, CHANGELOG_BODY_MAX } from '../../../src/services/project-changelog.js';
import { McpToolsRegistry, type ToolDeps } from '../../../src/services/mcp-tools.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake } from '../../helpers/db-fake.js';

const CARD_A = '11111111-1111-4111-8111-111111111111';
const CARD_OTHER = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const now = new Date().toISOString();
  const project = (id: number, slug: string) => ({
    id,
    slug,
    aboutJson: {},
    rosterMarkdown: '',
    latestEventSeq: 0,
    recentEvents: [],
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const card = (id: string, projectId: number) => ({
    id,
    projectId,
    boardId: randomUUID(),
    columnId: randomUUID(),
    cardNumber: 1,
    title: 'card',
    detail: '',
    position: 1,
    createdAt: now,
    updatedAt: now,
  });
  const seed = {
    coordProjects: [project(1, 'alpha'), project(2, 'beta')],
    coordProjectCards: [card(CARD_A, 1), card(CARD_OTHER, 2)],
  } as unknown as StateSeed;
  const raw = createDbFake(
    new Map([[schema.coordProjects, structuredClone(seed.coordProjects!) as unknown as Record<string, unknown>[]]]),
  );
  const db = scopedDatabase(raw);
  const state = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed));
  const deadlines = new DeadlineQueue((error) => {
    throw error;
  });
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(error) {
      throw error;
    },
    notificationError(error) {
      throw error;
    },
    committed() {},
    persistence: {
      async receipt() {
        return undefined;
      },
      async record() {},
      async transaction(run) {
        await run(raw as unknown as PersistenceTransaction);
      },
    },
  });
  const owner: OwnerRuntime = { state, deadlines, assertOwner() {}, execute: (command) => executor.execute(command) };
  bindOwnerRuntime(db, owner);
  const events = () =>
    (raw.tables.get(schema.coordProjectEvents) ?? []).map((row) => ({
      action: row.action,
      entityType: row.entityType,
      payload: typeof row.payloadJson === 'string' ? JSON.parse(row.payloadJson) : row.payloadJson,
    }));
  return {
    db,
    state,
    events,
    service: new ProjectChangelogService(db as never),
    close: () => deadlines.close(),
  };
}

const HOST_A = { hostId: 7 };
const HOST_B = { hostId: 8 };

describe('project changelog under the exclusive owner', () => {
  it('appends, updates and deletes with a full-state event per mutation', async () => {
    const h = fixture();
    const publish = vi.spyOn(wsPublisher, 'publish');
    try {
      const created = await h.service.append(
        'alpha',
        { title: 'Ship changelog', body: 'Because agents forget.', kind: 'feature', tags: ['UI', 'ui', 'api'], card_id: CARD_A },
        HOST_A,
      );
      expect(created.entry).toMatchObject({
        project: 'alpha',
        kind: 'feature',
        title: 'Ship changelog',
        tags: ['api', 'ui'],
        card_id: CARD_A,
        author_host_id: 7,
      });
      const id = created.entry.id;

      const updated = await h.service.update('alpha', id, { body: 'Because agents forget between sessions.' }, HOST_A);
      expect(updated.entry.body).toBe('Because agents forget between sessions.');
      expect(updated.entry.title).toBe('Ship changelog');

      await h.service.delete('alpha', id, HOST_A);
      expect(h.state.snapshot().table('coordProjectChangelog').all()).toEqual([]);

      const events = h.events();
      expect(events.map((e) => [e.entityType, e.action])).toEqual([
        ['changelog', 'create'],
        ['changelog', 'update'],
        ['changelog', 'delete'],
      ]);
      // The delete event keeps what it removed: the feed is the history.
      expect(events[2]!.payload).toMatchObject({
        id,
        title: 'Ship changelog',
        body: 'Because agents forget between sessions.',
        card_id: CARD_A,
        kind: 'feature',
      });
      expect(events[1]!.payload).toMatchObject({ body: 'Because agents forget between sessions.' });
      expect(publish).toHaveBeenCalledWith('project.changelog.created', expect.objectContaining({ slug: 'alpha' }));
      expect(publish).toHaveBeenCalledWith('project.changelog.deleted', expect.objectContaining({ entry_id: id }));
    } finally {
      publish.mockRestore();
      h.close();
    }
  });

  it("refuses another host's entry but lets the operator change it", async () => {
    const h = fixture();
    try {
      const { entry } = await h.service.append('alpha', { title: 'mine' }, HOST_A);
      await expect(h.service.update('alpha', entry.id, { title: 'theirs' }, HOST_B)).rejects.toMatchObject({
        code: 'not_owner',
      });
      await expect(h.service.delete('alpha', entry.id, HOST_B)).rejects.toMatchObject({ code: 'not_owner' });
      const edited = await h.service.update('alpha', entry.id, { title: 'operator fix' }, { hostId: null, operator: true });
      expect(edited.entry.title).toBe('operator fix');
      // Operator entries (no host) cannot be edited by any host.
      const op = await h.service.append('alpha', { title: 'operator note' }, { hostId: null, operator: true });
      await expect(h.service.update('alpha', op.entry.id, { title: 'x' }, HOST_A)).rejects.toMatchObject({
        code: 'not_owner',
      });
    } finally {
      h.close();
    }
  });

  it('validates card ownership, kind and size limits', async () => {
    const h = fixture();
    try {
      await expect(h.service.append('alpha', { title: 't', card_id: CARD_OTHER }, HOST_A)).rejects.toMatchObject({
        status: 422,
      });
      await expect(h.service.append('alpha', { title: 't', kind: 'party' }, HOST_A)).rejects.toMatchObject({
        status: 422,
      });
      await expect(
        h.service.append('alpha', { title: 't', body: 'x'.repeat(CHANGELOG_BODY_MAX + 1) }, HOST_A),
      ).rejects.toMatchObject({ status: 422 });
      await expect(h.service.append('alpha', { title: '' }, HOST_A)).rejects.toMatchObject({ status: 422 });
      const { entry } = await h.service.append('alpha', { title: 't', card_id: CARD_A }, HOST_A);
      const detached = await h.service.update('alpha', entry.id, { card_id: null }, HOST_A);
      expect(detached.entry.card_id).toBeNull();
      await expect(h.service.update('alpha', entry.id, {}, HOST_A)).rejects.toMatchObject({ status: 422 });
    } finally {
      h.close();
    }
  });

  it('lists newest first with filters and searches across projects', async () => {
    const h = fixture();
    try {
      await h.service.append('alpha', { title: 'Migrated auth tokens', body: 'rotated keys', kind: 'ops' }, HOST_A);
      await h.service.append('alpha', { title: 'Board card fix', card_id: CARD_A, kind: 'fix' }, HOST_A);
      await h.service.append('beta', { title: 'Decided on MySQL fulltext', kind: 'decision', tags: ['search'] }, HOST_B);

      const listed = await h.service.list('alpha');
      expect(listed.entries.map((e) => e.title)).toEqual(['Board card fix', 'Migrated auth tokens']);
      expect((await h.service.list('alpha', { cardId: CARD_A })).entries).toHaveLength(1);
      expect((await h.service.list('alpha', { kind: 'ops' })).entries[0]!.title).toBe('Migrated auth tokens');

      const fleet = await h.service.search({ query: 'fulltext' });
      expect(fleet.entries.map((e) => [e.project, e.title])).toEqual([['beta', 'Decided on MySQL fulltext']]);
      expect((await h.service.search({ query: 'fulltext', slug: 'alpha' })).entries).toEqual([]);
      expect((await h.service.search({ query: 'keys' })).entries[0]!.title).toBe('Migrated auth tokens');
      expect((await h.service.search({ tag: 'search' })).entries).toHaveLength(1);

      const timeline = await h.service.listFleet({});
      expect(timeline.entries).toHaveLength(3);
      expect(timeline.entries[0]!.project).toBe('beta');

      const page = await h.service.list('alpha', { limit: 1 });
      expect(page.next_before_id).toBe(page.entries[0]!.id);
      const next = await h.service.list('alpha', { limit: 1, beforeId: page.next_before_id });
      expect(next.entries[0]!.title).toBe('Migrated auth tokens');
    } finally {
      h.close();
    }
  });
});

describe('project changelog tool gating', () => {
  const deps = (enabled: boolean) =>
    ({
      projects: {},
      skills: {},
      changelog: {
        getEnabled: async () => enabled,
        assertEnabled: async () => {
          if (!enabled) throw Object.assign(new Error('disabled'), { code: 'project_changelog_disabled' });
        },
      },
    }) as unknown as ToolDeps;

  it('lists the tools only while the switch is on', async () => {
    const on = (await new McpToolsRegistry(deps(true)).listAvailable()).map((t) => t.name);
    const off = (await new McpToolsRegistry(deps(false)).listAvailable()).map((t) => t.name);
    for (const name of [
      'project_changelog_append',
      'project_changelog_update',
      'project_changelog_delete',
      'project_changelog_list',
      'project_changelog_search',
    ]) {
      expect(on).toContain(name);
      expect(off).not.toContain(name);
    }
    expect(off).toContain('project_summary');
  });

  it('refuses calls while the switch is off', async () => {
    const registry = new McpToolsRegistry(deps(false));
    const result = (await registry.dispatch('project_changelog_search', { query: 'x' }, { id: 1 } as schema.Host)) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('disabled');
  });
});
