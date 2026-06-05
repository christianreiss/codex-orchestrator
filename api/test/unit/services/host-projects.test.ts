import { describe, expect, it } from 'vitest';
import {
  coordProjectEvents,
  coordProjectFeedback,
  coordProjectFiles,
  coordProjectNotes,
  coordProjects,
  coordProjectTodos,
} from '../../../src/db/schema.js';
import { HostProjectsService } from '../../../src/services/host-projects.js';
import { createDbFake } from '../../helpers/db-fake.js';
import type { Host } from '../../../src/db/schema.js';

const host: Host = { id: 1, fqdn: 'host.example' } as unknown as Host;

describe('HostProjectsService bootstrap', () => {
  it('includes managed CoCo skill metadata and native guidance', async () => {
    const db = createDbFake();
    db.tables.set(coordProjects, [{
      id: 1,
      slug: 'demo',
      aboutJson: { purpose: 'test' },
      rosterMarkdown: '# Roster',
      latestEventSeq: 3,
      createdAt: '2026-06-03T08:00:00Z',
      updatedAt: '2026-06-03T08:01:00Z',
      archivedAt: null,
    }]);
    db.tables.set(coordProjectNotes, []);
    db.tables.set(coordProjectTodos, []);
    db.tables.set(coordProjectFiles, []);
    db.tables.set(coordProjectFeedback, []);
    db.tables.set(coordProjectEvents, []);

    const service = new HostProjectsService(db as never);
    const out = await service.bootstrap('demo', host);

    expect(out['skill']).toMatchObject({ slug: 'coco', uri: 'skill://coco', managed: true });
    expect(String(out['instructions'])).toContain('project_* MCP tools');
    expect(String(out['instructions'])).toContain('memory://');
    expect(out['quickstart']).toEqual(expect.arrayContaining([
      expect.stringContaining('project_bootstrap'),
      expect.stringContaining('project_changes'),
    ]));
  });
});
