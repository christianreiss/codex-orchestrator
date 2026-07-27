import { describe, it, expect } from 'vitest';
import { logs, sharedMemories, sharedMemoryChunks, sharedMemoryRevisions } from '../../../src/db/schema.js';
import { SharedMemoriesService } from '../../../src/services/shared-memories.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import type { Host } from '../../../src/db/schema.js';

const host: Host = { id: 3, fqdn: 'alpha.example' } as unknown as Host;
const otherHost: Host = { id: 9, fqdn: 'beta.example' } as unknown as Host;

function makeDb(): DbFake {
  const db = createDbFake();
  db.tables.set(logs, []);
  db.tables.set(sharedMemoryChunks, []);
  db.tables.set(sharedMemoryRevisions, []);
  db.tables.set(sharedMemories, []);
  return db;
}
const service = (db: DbFake) => new SharedMemoriesService(db as never);

describe('probe: append with explicit null/empty title', () => {
  it('title omitted -> preserved (control)', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'zprobe-title', content: 'body', title: 'Crane deploy runbook', summary: 'the summary' }, host);
    await service(db).append({ slug: 'zprobe-title', content: 'more' }, otherHost);
    const row = (db.tables.get(sharedMemories) ?? [])[0]!;
    console.log('OMITTED   ->', JSON.stringify({ title: row['title'], summary: row['summary'] }));
    expect(row['title']).toBe('Crane deploy runbook');
  });

  it('title: null -> ???', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'zprobe-title', content: 'body', title: 'Crane deploy runbook', summary: 'the summary' }, host);
    await service(db).append({ slug: 'zprobe-title', content: 'more', title: null }, otherHost);
    const row = (db.tables.get(sharedMemories) ?? [])[0]!;
    console.log('NULL      ->', JSON.stringify({ title: row['title'], summary: row['summary'] }));
    const revs = (db.tables.get(sharedMemoryRevisions) ?? []).map((r) => Object.keys(r));
    console.log('REV KEYS  ->', JSON.stringify(revs[0] ?? []));
  });

  it('title: "" -> ???', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'zprobe-title', content: 'body', title: 'Crane deploy runbook' }, host);
    await service(db).append({ slug: 'zprobe-title', content: 'more', title: '' }, otherHost);
    console.log('EMPTY STR ->', JSON.stringify({ title: (db.tables.get(sharedMemories) ?? [])[0]!['title'] }));
  });

  it('title: "   " (whitespace) -> ???', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'zprobe-title', content: 'body', title: 'Crane deploy runbook' }, host);
    await service(db).append({ slug: 'zprobe-title', content: 'more', title: '   ' }, otherHost);
    console.log('WHITESPCE ->', JSON.stringify({ title: (db.tables.get(sharedMemories) ?? [])[0]!['title'] }));
  });

  it('summary: null -> ??? (comparison field)', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'zprobe-title', content: 'body', title: 'Crane deploy runbook', summary: 'the summary' }, host);
    await service(db).append({ slug: 'zprobe-title', content: 'more', summary: null }, otherHost);
    console.log('SUMM NULL ->', JSON.stringify({ summary: (db.tables.get(sharedMemories) ?? [])[0]!['summary'] }));
  });
});
