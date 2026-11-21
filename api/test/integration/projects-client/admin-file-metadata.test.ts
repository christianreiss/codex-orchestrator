import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectContentService } from '../../../src/services/project-content.js';
import { ProjectsService } from '../../../src/services/projects.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();
const slug = 'file-metadata-' + randomUUID();
const inputs = [
  { stored_name: 'z.txt', content: 'Käse' },
  { stored_name: 'a.bin', encoding: 'base64', content: 'AQI=' },
];

describe.skipIf(!handle)('admin project file projection on MySQL', () => {
  let content: ProjectContentService;
  beforeAll(async () => {
    const projects = new ProjectsService(handle!.db);
    content = new ProjectContentService(handle!.db, projects);
    await projects.create({ slug });
    for (const file of inputs) await content.upsertFile(slug, file);
  });
  afterAll(async () => {
    if (handle) {
      await handle.db.execute(sql`DELETE FROM coord_projects WHERE slug = ${slug}`);
      await handle.pool.end();
    }
  });
  it('omits bodies while preserving the legacy order, decoded sizes, MIME, digest and timestamps', async () => {
    const baseline = await content.listFiles(slug);
    const slim = await content.listFileMetadata(slug);
    expect(slim.project).toBe(slug);
    expect(slim.files.map((f) => [f.stored_name, f.size_bytes])).toEqual([
      ['a.bin', 2],
      ['z.txt', 5],
    ]);
    expect(slim.files).toEqual(baseline.files.map(({ content: _content, ...metadata }) => metadata));
    const selected = await content.readFile(slug, slim.files[0]!.id);
    expect(selected.file.content).toBe('AQI=');
    expect(selected.file.content_sha256).toBe(slim.files[0]!.content_sha256);
    await content.deleteFile(slug, slim.files[0]!.id);
    expect((await content.listFileMetadata(slug)).files.map((f) => f.stored_name)).toEqual(['z.txt']);
  });
});
