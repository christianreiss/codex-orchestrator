import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { coordProjectFiles } from '../db/schema.js';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { decodedLengthFromStored } from './project-file-encoding.js';

/** Preserve the caller's display order without materializing project file bodies. */
export async function projectFileSummaries(db: Database, projectId: number, order: 'name' | 'recent') {
  const owner = ownerRuntimeFor(db);
  owner?.assertOwner();
  const state = owner?.state.snapshot();
  const rows = state
    ? state
        .table('coordProjectFiles')
        .by('projectId', projectId)
        .slice()
        .sort((a, b) =>
          order === 'name'
            ? a.storedName.localeCompare(b.storedName)
            : b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id,
        )
    : await db
        .select({
          id: coordProjectFiles.id,
          projectId: coordProjectFiles.projectId,
          storedName: coordProjectFiles.storedName,
          description: coordProjectFiles.description,
          contentSha256: coordProjectFiles.contentSha256,
          mimeType: coordProjectFiles.mimeType,
          contentEncoding: coordProjectFiles.contentEncoding,
          sizeBytes: sql<number>`octet_length(${coordProjectFiles.content})`,
          // The last two characters are all that is needed to count base64
          // padding, and two characters is not a body.
          contentTail: sql<string>`right(${coordProjectFiles.content}, 2)`,
          sourceHostId: coordProjectFiles.sourceHostId,
          createdAt: coordProjectFiles.createdAt,
          updatedAt: coordProjectFiles.updatedAt,
        })
        .from(coordProjectFiles)
        .where(eq(coordProjectFiles.projectId, projectId))
        .orderBy(
          ...(order === 'name'
            ? [asc(coordProjectFiles.storedName)]
            : [desc(coordProjectFiles.updatedAt), desc(coordProjectFiles.id)]),
        );
  return rows.map((r) => ({
    id: r.id,
    project_id: r.projectId,
    stored_name: r.storedName,
    description: r.description ?? null,
    content_sha256: r.contentSha256,
    mime_type: r.mimeType ?? null,
    content_encoding: r.contentEncoding ?? 'utf8',
    size_bytes: decodedLengthFromStored(
      Number(r.sizeBytes ?? 0),
      String(r.contentTail ?? ''),
      r.contentEncoding,
    ),
    source_host_id: r.sourceHostId ?? null,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));
}
