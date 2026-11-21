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

  it('round-trips an existing zero-byte Base64 document and rejects missing or empty text inputs', async () => {
    // Older servers already accepted whitespace-only Base64 and persisted the empty canonical body.
    const original = (
      await content.upsertFile(slug, { stored_name: 'empty.bin', text: '    ', encoding: 'b64' })
    ).file;
    const detail = (await content.readFile(slug, original.id)).file;
    expect(detail).toMatchObject({
      content: '',
      content_encoding: 'base64',
      size_bytes: 0,
      content_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    const changed = (
      await content.upsertFile(slug, {
        stored_name: detail.stored_name,
        encoding: detail.content_encoding,
        content: detail.content,
        description: 'Updated empty binary',
      })
    ).file;
    expect(changed).toMatchObject({
      id: detail.id,
      content: '',
      content_sha256: detail.content_sha256,
      size_bytes: 0,
    });
    for (const invalid of [
      { encoding: 'base64' },
      { content: null, encoding: 'base64' },
      { content: 12, encoding: 'base64' },
      { content: '', encoding: 'utf8' },
      { text: '' },
    ]) {
      await expect(content.upsertFile(slug, { stored_name: detail.stored_name, ...invalid })).rejects.toThrow(
        'content is required',
      );
    }
    expect((await content.readFile(slug, original.id)).file.description).toBe('Updated empty binary');
  });
});
