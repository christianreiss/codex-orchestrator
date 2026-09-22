import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { ProjectBoardService } from '../../../src/services/project-board.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The scenario this whole change set came from: an agent planning a mail server
 * migration, needing tasks, files, todos and the rest of a project's life.
 *
 * Every step below failed or was impossible before: `project_summary` did not
 * exist and `project_bootstrap` returned 62 KB, the PDF could only be smuggled
 * through as text, `about` could not be changed after creation, feedback could
 * be filed and never closed, and nothing could ever mark the project finished.
 */

const SLUG = 'ztest-mailmigration';
const FQDN = 'ztest-mail.example';

const handle = await getTestDb();

describe.skipIf(!handle)('a mail server migration, end to end', () => {
  let db: TestDb;
  let svc: HostProjectsService;
  let board: ProjectBoardService;
  let host: Host;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const cleanup = async () => {
    await exec(`DELETE FROM coord_projects WHERE slug = '${SLUG}'`);
    await exec(`DELETE FROM hosts WHERE fqdn = '${FQDN}'`);
  };

  beforeAll(async () => {
    db = handle!.db;
    await cleanup();
    const now = new Date().toISOString();
    await exec(
      `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
       VALUES ('${FQDN}', SHA2('${FQDN}', 256), 'active', '${now}', '${now}')`,
    );
    host = rowsOf(await exec(`SELECT id, fqdn FROM hosts WHERE fqdn = '${FQDN}'`))[0] as unknown as Host;
    svc = new HostProjectsService(db);
    board = new ProjectBoardService({ db, projects: svc });
    await exec(
      `INSERT INTO versions (name, version, updated_at)
       VALUES ('project_board_enabled', '1', '${now}')
       ON DUPLICATE KEY UPDATE version = '1'`,
    );
  });

  afterAll(async () => {
    await cleanup();
    await handle?.pool.end();
  });

  it('charters the project', async () => {
    await svc.createProject(
      {
        slug: SLUG,
        about: {
          title: 'Mail server migration — mx1 → mx2',
          owner: 'Chris',
          status: 'planning',
          scope: 'Postfix + Dovecot + DNS cutover. 400 mailboxes.',
        },
      },
      host,
    );
    const summary = await svc.summary(SLUG, {}, host);
    expect((summary['about'] as Record<string, unknown>)['status']).toBe('planning');
    expect(summary['board']).toMatchObject({ status: 'available' });
  });

  it('attaches discovery evidence, text and binary alike', async () => {
    await svc.upsertFile(
      SLUG,
      { stored_name: 'context/postfix-main.cf', content: 'myhostname = mx1\n'.repeat(400) },
      host,
    );
    await svc.upsertFile(
      SLUG,
      {
        stored_name: 'context/mailbox-inventory.csv',
        content: 'user,quota_mb\n' + Array.from({ length: 400 }, (_, i) => `user${i}@example.org,2048`).join('\n'),
      },
      host,
    );

    // The vendor's migration contract, as an actual PDF.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(120_000, 0xab)]);
    await svc.upsertFile(
      SLUG,
      { stored_name: 'context/vendor-contract.pdf', content: pdf.toString('base64'), encoding: 'base64' },
      host,
    );

    const listing = (await svc.listFileSummaries(SLUG, host)) as { files: Record<string, unknown>[] };
    const byName = new Map(listing.files.map((f) => [String(f['stored_name']), f]));
    expect(byName.get('context/vendor-contract.pdf')).toMatchObject({
      size_bytes: pdf.length,
      mime_type: 'application/pdf',
      content_encoding: 'base64',
      content_sha256: createHash('sha256').update(pdf).digest('hex'),
    });
    // Inferred, not supplied.
    expect(byName.get('context/mailbox-inventory.csv')!['mime_type']).toBe('text/csv');

    // ~135 KB stored, and the listing an agent reads is under 2 KB.
    expect(JSON.stringify(listing).length).toBeLessThan(2_000);
  });

  it('decomposes the work onto the board and runs a card through it', async () => {
    for (const title of ['Freeze DNS TTLs', 'Rsync maildirs', 'Cut MX over', 'Decommission mx1']) {
      await board.createCard({ slug: SLUG, title }, host);
    }

    const claim = (await board.claimCard(
      { slug: SLUG, card: 2, role: 'ops', username: 'chris', worktree_path: '/srv/mail' },
      host,
    )) as Record<string, unknown>;
    expect(claim['claimed']).toBe(true);

    await board.moveCard({ slug: SLUG, card: 2, column: 'coding', role: 'ops' }, host);
    const released = (await board.releaseCard(
      { slug: SLUG, card: 2, resolution: 'handoff', note: 'First pass synced; delta pass pending.' },
      host,
    )) as Record<string, unknown>;
    expect(released['released']).toBe(true);

    const summary = await svc.summary(SLUG, {}, host);
    const boardBlock = summary['board'] as Record<string, unknown>;
    const open = boardBlock['open_cards'] as Record<string, unknown>[];
    expect(open.length).toBe(4);
    // Card detail bodies are not in the summary; titles are.
    expect(open.every((c) => !('detail' in c))).toBe(true);
  });

  it('records a review and closes it out', async () => {
    await svc.createFeedback(
      SLUG,
      { type: 'issue', title: 'SPF still lists mx1', body: 'Update the TXT record before the TTL freeze.' },
      host,
    );
    const filed = (await svc.listFeedback(SLUG, host)) as { feedback: Record<string, unknown>[] };
    expect(filed.feedback[0]!['status']).toBe('open');

    await svc.updateFeedback(SLUG, Number(filed.feedback[0]!['id']), { status: 'resolved' }, host);
    const closed = (await svc.listFeedback(SLUG, host)) as { feedback: Record<string, unknown>[] };
    expect(closed.feedback[0]!['status']).toBe('resolved');
  });

  it('moves the project through its own states and closes it', async () => {
    // Merge, not replace: bumping status must not drop owner or scope.
    await svc.updateProject(SLUG, { about: { status: 'cutover-complete', last_verified: '2026-09-22' } }, host);
    const after = (await svc.summary(SLUG, {}, host))['about'] as Record<string, unknown>;
    expect(after).toMatchObject({
      status: 'cutover-complete',
      last_verified: '2026-09-22',
      owner: 'Chris',
      scope: 'Postfix + Dovecot + DNS cutover. 400 mailboxes.',
    });

    await svc.archiveProject(SLUG, { reason: 'Cutover complete, mx1 decommissioned.' }, host);

    const visible = (await svc.listProjects(host)) as { projects: { slug: string }[] };
    expect(visible.projects.map((p) => p.slug)).not.toContain(SLUG);

    const all = (await svc.listProjects(host, { include_archived: true })) as { projects: { slug: string }[] };
    expect(all.projects.map((p) => p.slug)).toContain(SLUG);

    // Closed, not gone: still readable by slug, with its evidence intact.
    const summary = await svc.summary(SLUG, {}, host);
    expect(summary['archived_at']).toBeTruthy();
    expect((summary['counts'] as Record<string, number>)['files']).toBe(3);

    await svc.unarchiveProject(SLUG, host);
    expect((await svc.summary(SLUG, {}, host))['archived_at']).toBeNull();
  });

  it('lets a second agent resume from the event log without replaying it', async () => {
    const seq = Number((await svc.summary(SLUG, {}, host))['latest_seq']);
    await svc.upsertNote(SLUG, null, { header: 'Handoff', body: 'x'.repeat(20_000) }, host);

    const caughtUp = (await svc.listChanges(SLUG, seq, host, { payloads: 'preview' })) as {
      since: number;
      changes: { payload: Record<string, unknown> }[];
    };
    expect(caughtUp.since).toBe(seq);
    expect(caughtUp.changes).toHaveLength(1);
    expect(String(caughtUp.changes[0]!.payload['body'])).toHaveLength(280);
    expect(caughtUp.changes[0]!.payload['body_length']).toBe(20_000);
  });
});
