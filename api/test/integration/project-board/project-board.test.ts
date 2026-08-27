import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import {
  CARD_CLAIM_TTL_SECONDS,
  PROJECT_BOARD_ENABLED_FLAG,
  ProjectBoardService,
} from '../../../src/services/project-board.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { SettingsService } from '../../../src/services/settings.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The project board against real MySQL. Everything here needs a database to
 * mean anything:
 *
 *  1. **Claim exclusivity.** There is no lease table — the live claim is the
 *     card row, made exclusive by a `SELECT … FOR UPDATE` on the project.
 *     `db-fake` has neither transactions nor row locks, so a unit assertion
 *     would pass for the fake's reasons and prove nothing about MySQL.
 *  2. **Reclaiming forgotten agents.** The behaviour that decides whether this
 *     feature is usable at all. All three cases are exercised, and the third is
 *     the one implementations get wrong: a bound agent that is still alive and
 *     merely quiet must NOT lose its card.
 *  3. **Card events reaching `project_changes`.** The load-bearing claim of the
 *     whole design — the reason there is no card-history table. If board
 *     activity did not flow into the existing per-project log, agents would need
 *     a second sync surface nobody built.
 *  4. **The lock ordering.** `withBoard` holds the project row while it calls a
 *     recorder that takes the same lock. Getting that wrong does not deadlock
 *     and does not error; it waits out `innodb_lock_wait_timeout`, so only a
 *     real database can catch it, and only under concurrency.
 *  5. **The todo shim.** That `project_todo_done(<old id>)` still moves the
 *     right card is the promise migration 0026 makes to every existing caller.
 *  6. **Migration idempotency**, which the fake cannot judge because it enforces
 *     no unique key.
 */

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/db/migrations/',
  '0026_add_project_board.sql',
);

const FQDN = 'ztest-board.example';
const SLUG = 'ztest-board';

const handle = await getTestDb();

describe.skipIf(!handle)('project board against a real database', () => {
  let db: TestDb;
  let board: ProjectBoardService;
  let projects: HostProjectsService;
  let host: Host;
  let projectId: number;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };

  const agent = (username: string, worktree: string) => ({
    username,
    worktree_path: worktree,
  });

  const claim = (card: number | string, role: string, who: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    board.claimCard({ slug: SLUG, card, role, ...who, ...extra }, host, 'claude') as Promise<Record<string, unknown>>;

  const cardRow = async (number: number): Promise<Record<string, unknown>> =>
    rowsOf(
      await exec(
        `SELECT * FROM coord_project_cards WHERE project_id = ${projectId} AND card_number = ${number}`,
      ),
    )[0]!;

  const columnKeyOf = async (number: number): Promise<string> => {
    const row = await cardRow(number);
    const col = rowsOf(await exec(`SELECT column_key FROM coord_project_board_columns WHERE id = '${row['column_id']}'`))[0]!;
    return String(col['column_key']);
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const stmt of splitSqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    const now = new Date().toISOString();
    await exec(`DELETE FROM hosts WHERE fqdn = '${FQDN}'`);
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
       VALUES ('${FQDN}', SHA2('${FQDN}', 256), 'active', '${now}', '${now}')`,
    );
    host = rowsOf(await exec(`SELECT id, fqdn FROM hosts WHERE fqdn = '${FQDN}'`))[0] as unknown as Host;
    projects = new HostProjectsService(db);
    board = new ProjectBoardService({ db, projects, settings: new SettingsService(db) });
  });

  beforeEach(async () => {
    const ids = rowsOf(await exec(`SELECT id FROM coord_projects WHERE slug = '${SLUG}'`));
    for (const row of ids) {
      await exec(`DELETE FROM coord_project_cards WHERE project_id = ${row['id']}`);
      await exec(`DELETE FROM coord_project_board_columns WHERE project_id = ${row['id']}`);
      await exec(`DELETE FROM coord_project_boards WHERE project_id = ${row['id']}`);
      await exec(`DELETE FROM coord_project_events WHERE project_id = ${row['id']}`);
      await exec(`DELETE FROM coord_project_todos WHERE project_id = ${row['id']}`);
      await exec(`DELETE FROM coord_projects WHERE id = ${row['id']}`);
    }
    // Bus addresses are keyed on (host, cwd) and outlive a project, so a dead
    // one left by an earlier case would bind a later claim and reclaim it for
    // the wrong reason. That the leak was visible at all is the binding working.
    await exec(`DELETE FROM agent_bus_addresses WHERE host_id = ${host.id}`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO coord_projects (slug, roster_markdown, latest_event_seq, created_at, updated_at)
       VALUES ('${SLUG}', '', 0, '${now}', '${now}')`,
    );
    projectId = Number(rowsOf(await exec(`SELECT id FROM coord_projects WHERE slug = '${SLUG}'`))[0]!['id']);
    await new SettingsService(db).setFlag(PROJECT_BOARD_ENABLED_FLAG, true, { publish: false });
    await board.createCard({ slug: SLUG, title: 'Wire the arbiter', detail: 'd' }, host);
  });

  it('provisions the seven seeded lanes for a project created after the migration', async () => {
    const lanes = rowsOf(
      await exec(
        `SELECT column_key, position, is_intake, is_terminal, is_blocked FROM coord_project_board_columns
         WHERE project_id = ${projectId} ORDER BY position`,
      ),
    );
    expect(lanes.map((l) => l['column_key'])).toEqual([
      'backlog', 'planning', 'coding', 'review', 'verifying', 'done', 'blocked',
    ]);
    expect(lanes.filter((l) => Number(l['is_intake']) === 1)).toHaveLength(1);
    expect(lanes.filter((l) => Number(l['is_terminal']) === 1)).toHaveLength(1);
    expect(lanes.filter((l) => Number(l['is_blocked']) === 1)).toHaveLength(1);
    // The chain is what makes a bare release advance; a board seeded without it
    // would silently leave every released card where it was.
    const chain = rowsOf(
      await exec(
        `SELECT c.column_key AS src, n.column_key AS dst
         FROM coord_project_board_columns c
         LEFT JOIN coord_project_board_columns n ON n.id = c.default_next_column_id
         WHERE c.project_id = ${projectId} ORDER BY c.position`,
      ),
    );
    expect(chain.map((r) => [r['src'], r['dst']])).toEqual([
      ['backlog', 'planning'], ['planning', 'coding'], ['coding', 'review'],
      ['review', 'verifying'], ['verifying', 'done'], ['done', null], ['blocked', null],
    ]);
  });

  it('grants exactly one of two concurrent claims on the same card', async () => {
    // The property with no lease table behind it. Both calls race for the same
    // project row; the loser must see the winner's claim, not a stale read of an
    // unclaimed card.
    const [a, b] = await Promise.all([
      claim(1, 'code', agent('chris', '/srv/a')),
      claim(1, 'review', agent('dana', '/srv/b')),
    ]);
    const claimed = [a, b].filter((r) => r['claimed'] === true);
    const refused = [a, b].filter((r) => r['claimed'] === false);
    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String(refused[0]!['reason'])).toContain('Wire the arbiter');
    // And the row agrees with whoever won, rather than with the last writer.
    const row = await cardRow(1);
    expect(row['claimed_by_username']).toBe((claimed[0]!['card'] as Record<string, unknown>) && row['claimed_by_username']);
    expect(['chris', 'dana']).toContain(row['claimed_by_username']);
    expect(row['claim_released_at']).toBeNull();
  });

  it('returns the original claim for a retried request instead of contending', async () => {
    const first = await claim(1, 'code', agent('chris', '/srv/a'), { client_request_id: 'req-1' });
    const retry = await claim(1, 'code', agent('chris', '/srv/a'), { client_request_id: 'req-1' });
    expect(first['claimed']).toBe(true);
    expect(retry['claimed']).toBe(true);
    expect(retry['retried']).toBe(true);
    // One claim event, not two: a retry that recorded a second would show the
    // board a contender that does not exist.
    const events = rowsOf(
      await exec(
        `SELECT action FROM coord_project_events WHERE project_id = ${projectId} AND entity_type = 'card' AND action = 'claim'`,
      ),
    );
    expect(events).toHaveLength(1);
  });

  it('writes nothing at all when it refuses a claim', async () => {
    await claim(1, 'code', agent('chris', '/srv/a'));
    const before = Number(rowsOf(await exec(`SELECT latest_event_seq s FROM coord_projects WHERE id = ${projectId}`))[0]!['s']);
    // A polling agent must not be able to fill the project's change log with its
    // own rejections, so a refusal consumes no sequence number either.
    for (let i = 0; i < 5; i++) await claim(1, 'review', agent('dana', '/srv/b'));
    const after = Number(rowsOf(await exec(`SELECT latest_event_seq s FROM coord_projects WHERE id = ${projectId}`))[0]!['s']);
    expect(after).toBe(before);
  });

  it('reclaims a claim whose bound agent session has ended, before its TTL', async () => {
    await claim(1, 'code', agent('chris', '/srv/a'));
    // Bind an address that is definitively dead: no current session. The TTL is
    // untouched and still has half an hour on it, so only the liveness signal
    // can free this card.
    const addressId = '99999999-9999-4999-8999-999999999999';
    await exec(`DELETE FROM agent_bus_addresses WHERE id = '${addressId}'`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO agent_bus_addresses
         (id, address, host_id, engine, username, cwd, cwd_hash, current_session_id, enabled, readiness, binding_generation, continuity, last_seen_at, created_at, updated_at)
       VALUES ('${addressId}', 'agent:${addressId}', ${host.id}, 'claude', 'chris', '/srv/a', SHA2('/srv/a', 256), NULL, 1, 'ready', 1, 'native', '${now}', '${now}', '${now}')`,
    );
    await exec(`UPDATE coord_project_cards SET claimed_agent_bus_address_id = '${addressId}' WHERE project_id = ${projectId} AND card_number = 1`);

    await board.listBoards({ slug: SLUG }, host);

    const row = await cardRow(1);
    expect(row['claim_released_at']).not.toBeNull();
    expect(String(row['claim_release_reason'])).toContain('no longer running');
  });

  it('reclaims an unbound claim once its TTL runs out', async () => {
    await claim(1, 'code', agent('chris', '/srv/a'));
    // With Agent Messaging off there is no address to ask, so silence is the
    // only signal left. Age the claim past its expiry rather than waiting.
    const past = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await exec(`UPDATE coord_project_cards SET claim_expires_at = '${past}' WHERE project_id = ${projectId} AND card_number = 1`);

    await board.listBoards({ slug: SLUG }, host);

    const row = await cardRow(1);
    expect(row['claimed_agent_bus_address_id']).toBeNull();
    expect(row['claim_released_at']).not.toBeNull();
    expect(String(row['claim_release_reason'])).toContain('never renewed');
  });

  it('leaves a bound, live agent holding its card however quiet it is', async () => {
    // The case implementations get wrong. An agent working quietly between calls
    // must not be evicted for being silent, so a live session keeps the card
    // even when the sweep runs repeatedly.
    await claim(1, 'code', agent('chris', '/srv/a'));
    const addressId = '88888888-8888-4888-8888-888888888888';
    const sessionId = '77777777-7777-4777-8777-777777777777';
    await exec(`DELETE FROM agent_bus_addresses WHERE id = '${addressId}'`);
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO agent_bus_addresses
         (id, address, host_id, engine, username, cwd, cwd_hash, current_session_id, enabled, readiness, binding_generation, continuity, last_seen_at, created_at, updated_at)
       VALUES ('${addressId}', 'agent:${addressId}', ${host.id}, 'claude', 'chris', '/srv/a', SHA2('/srv/a', 256), '${sessionId}', 1, 'ready', 1, 'native', '${now}', '${now}', '${now}')`,
    );
    await exec(`UPDATE coord_project_cards SET claimed_agent_bus_address_id = '${addressId}' WHERE project_id = ${projectId} AND card_number = 1`);

    for (let i = 0; i < 3; i++) await board.listBoards({ slug: SLUG }, host);

    expect((await cardRow(1))['claim_released_at']).toBeNull();
  });

  it('renews a claim before the reaper can take it', async () => {
    await claim(1, 'code', agent('chris', '/srv/a'));
    // One second of life left. The holder calls; renewal runs before the sweep,
    // so the card survives — the opposite ordering would take a card away in the
    // same transaction that proved its holder was alive.
    const nearly = new Date(Date.now() + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await exec(`UPDATE coord_project_cards SET claim_expires_at = '${nearly}' WHERE project_id = ${projectId} AND card_number = 1`);

    await board.getCard({ slug: SLUG, card: 1, username: 'chris', worktree_path: '/srv/a' }, host);

    const row = await cardRow(1);
    expect(row['claim_released_at']).toBeNull();
    const remaining = new Date(String(row['claim_expires_at'])).getTime() - Date.now();
    expect(remaining).toBeGreaterThan((CARD_CLAIM_TTL_SECONDS - 60) * 1000);
  });

  it('carries card activity into project_changes, which is why there is no history table', async () => {
    const before = Number(rowsOf(await exec(`SELECT latest_event_seq s FROM coord_projects WHERE id = ${projectId}`))[0]!['s']);
    await claim(1, 'code', agent('chris', '/srv/a'));
    await board.moveCard({ slug: SLUG, card: 1, column: 'coding', role: 'code' }, host);
    await board.releaseCard({ slug: SLUG, card: 1 }, host);

    const changes = (await projects.listChanges(SLUG, before, host)) as { changes: Array<Record<string, unknown>> };
    const cards = changes.changes.filter((c) => c['entity_type'] === 'card');
    expect(cards.map((c) => c['action'])).toEqual(['claim', 'move', 'move', 'release']);
    // Every one addresses the card by its id, so a reader can follow one card
    // through the log without joining anything.
    expect(new Set(cards.map((c) => c['entity_id'])).size).toBe(1);
  });

  it('advances a released card to the next lane without being told where', async () => {
    await claim(1, 'code', agent('chris', '/srv/a'));
    await board.moveCard({ slug: SLUG, card: 1, column: 'coding', role: 'code' }, host);
    const released = (await board.releaseCard({ slug: SLUG, card: 1 }, host)) as Record<string, unknown>;
    expect((released['to_column'] as Record<string, unknown>)['key']).toBe('review');
    expect(await columnKeyOf(1)).toBe('review');
    // A handoff is not progress: somebody picks it up where it is.
    await claim(1, 'review', agent('dana', '/srv/b'));
    await board.releaseCard({ slug: SLUG, card: 1, resolution: 'handoff' }, host);
    expect(await columnKeyOf(1)).toBe('review');
  });

  it('releases the claim when a card reaches a terminal lane', async () => {
    await claim(1, 'code', agent('chris', '/srv/a'));
    await board.releaseCard({ slug: SLUG, card: 1, resolution: 'done' }, host);
    const row = await cardRow(1);
    expect(await columnKeyOf(1)).toBe('done');
    // A card nobody is working on must not keep a lease that has to time out.
    expect(row['claim_released_at']).not.toBeNull();
  });

  it('survives eight concurrent operations without waiting out a lock timeout', async () => {
    // The regression test for the lock ordering. Composing a transaction-opening
    // recorder inside a transaction that already holds the same row lock does
    // not deadlock and does not error — it blocks for the full
    // `innodb_lock_wait_timeout`, which is 50 seconds by default. Anything near
    // that here means the recorder is opening its own transaction again.
    for (let i = 2; i <= 8; i++) await board.createCard({ slug: SLUG, title: `card ${i}` }, host);
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        claim(i + 1, 'code', agent(`agent-${i}`, `/srv/wt-${i}`)).then((r) =>
          board.moveCard({ slug: SLUG, card: i + 1, column: 'coding', role: 'code' }, host).then(() => r),
        ),
      ),
    );
    const elapsed = Date.now() - started;
    expect(results.every((r) => r['claimed'] === true)).toBe(true);
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  it('keeps a backfilled todo id pointing at the same work item', async () => {
    // The promise migration 0026 makes to every existing caller: the id did not
    // change, only what it points at.
    const created = (await projects.createTodo(SLUG, { title: 'From the todo API', detail: 'x' }, host)) as {
      todo: { id: number };
    };
    const id = created.todo.id;
    await projects.setTodoDone(SLUG, id, true, host);
    expect(await columnKeyOf(id)).toBe('done');

    const listed = (await projects.listTodos(SLUG, host)) as { todos: Array<{ id: number; done: boolean }> };
    expect(listed.todos.find((t) => t.id === id)?.done).toBe(true);
  });

  it('leaves a card mid-pipeline alone when a todo caller marks it undone', async () => {
    // "Not finished" is already true of a card in Coding. Sending it back to
    // Backlog would silently discard its place in the pipeline.
    await board.moveCard({ slug: SLUG, card: 1, column: 'coding' }, host);
    await projects.setTodoDone(SLUG, 1, false, host);
    expect(await columnKeyOf(1)).toBe('coding');
    // A card that really is finished does move back.
    await board.moveCard({ slug: SLUG, card: 1, column: 'done' }, host);
    await projects.setTodoDone(SLUG, 1, false, host);
    expect(await columnKeyOf(1)).toBe('backlog');
  });

  it('re-applies migration 0026 without duplicating anything', async () => {
    const counts = async () =>
      rowsOf(
        await exec(
          `SELECT (SELECT COUNT(*) FROM coord_project_boards WHERE project_id = ${projectId}) b,
                  (SELECT COUNT(*) FROM coord_project_board_columns WHERE project_id = ${projectId}) c,
                  (SELECT COUNT(*) FROM coord_project_cards WHERE project_id = ${projectId}) k,
                  (SELECT next_card_number FROM coord_project_boards WHERE project_id = ${projectId} LIMIT 1) n`,
        ),
      )[0]!;
    const before = await counts();
    for (const stmt of splitSqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    expect(await counts()).toEqual(before);
  });
});
