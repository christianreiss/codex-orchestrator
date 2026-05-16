import { eq } from 'drizzle-orm';
import {
  coordProjects,
  coordProjectNotes,
  coordProjectTodos,
  coordProjectFiles,
  coordProjectFeedback,
  coordProjectEvents,
  type CoordProject,
} from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeCoordProjectOverrides {
  slug?: string;
  aboutJson?: unknown;
  rosterMarkdown?: string;
  archivedAt?: string | null;
}

export async function makeCoordProject(
  db: TestDb,
  overrides: MakeCoordProjectOverrides = {},
): Promise<CoordProject> {
  const slug = overrides.slug ?? `proj-${Math.random().toString(36).slice(2, 8)}`;
  const now = nowIso();

  await db.insert(coordProjects).values({
    slug,
    aboutJson: overrides.aboutJson ?? { name: slug, summary: 'test project' },
    rosterMarkdown: overrides.rosterMarkdown ?? '## Roster\n- test\n',
    latestEventSeq: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: overrides.archivedAt ?? null,
  });

  const [row] = await db
    .select()
    .from(coordProjects)
    .where(eq(coordProjects.slug, slug))
    .limit(1);
  if (!row) throw new Error('makeCoordProject: row not found after insert');
  return row;
}

export interface MakeCoordChildOverrides {
  sourceHostId?: number | null;
}

export async function makeCoordProjectNote(
  db: TestDb,
  project: CoordProject,
  overrides: MakeCoordChildOverrides & { header?: string; body?: string } = {},
) {
  const now = nowIso();
  await db.insert(coordProjectNotes).values({
    projectId: project.id,
    header: overrides.header ?? 'Note header',
    body: overrides.body ?? 'Note body',
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function makeCoordProjectTodo(
  db: TestDb,
  project: CoordProject,
  overrides: MakeCoordChildOverrides & { title?: string; detail?: string; done?: 0 | 1 } = {},
) {
  const now = nowIso();
  await db.insert(coordProjectTodos).values({
    projectId: project.id,
    title: overrides.title ?? 'TODO title',
    detail: overrides.detail ?? 'TODO detail',
    done: overrides.done ?? 0,
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function makeCoordProjectFile(
  db: TestDb,
  project: CoordProject,
  overrides: MakeCoordChildOverrides & {
    storedName?: string;
    content?: string;
    description?: string;
    mimeType?: string;
  } = {},
) {
  const content = overrides.content ?? 'file contents';
  const now = nowIso();
  await db.insert(coordProjectFiles).values({
    projectId: project.id,
    storedName: overrides.storedName ?? `file-${Math.random().toString(36).slice(2, 6)}.txt`,
    description: overrides.description ?? null,
    content,
    contentSha256: sha256(content),
    mimeType: overrides.mimeType ?? 'text/plain',
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function makeCoordProjectFeedback(
  db: TestDb,
  project: CoordProject,
  overrides: MakeCoordChildOverrides & {
    type?: string;
    title?: string;
    body?: string;
    status?: string;
  } = {},
) {
  const now = nowIso();
  await db.insert(coordProjectFeedback).values({
    projectId: project.id,
    type: overrides.type ?? 'bug',
    title: overrides.title ?? 'Feedback title',
    body: overrides.body ?? 'Feedback body',
    status: overrides.status ?? 'open',
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function makeCoordProjectEvent(
  db: TestDb,
  project: CoordProject,
  overrides: MakeCoordChildOverrides & {
    seq?: number;
    eventType?: string;
    action?: string;
    entityType?: string;
    entityId?: string;
    payloadJson?: unknown;
  } = {},
) {
  const now = nowIso();
  const seq = overrides.seq ?? Date.now();
  await db.insert(coordProjectEvents).values({
    projectId: project.id,
    seq,
    eventType: overrides.eventType ?? 'note',
    action: overrides.action ?? 'create',
    entityType: overrides.entityType ?? 'note',
    entityId: overrides.entityId ?? null,
    payloadJson: overrides.payloadJson ?? null,
    sourceHostId: overrides.sourceHostId ?? null,
    createdAt: now,
  });
}
