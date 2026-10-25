import type { Row } from '../control-plane/state/catalog.js';
import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import { chunkContent } from './shared-memory-chunker.js';
import { parseTags } from './memory-tags.js';

type Hit = Record<string, unknown> & { updated_at: string; memory_id: number; ordinal: number };
interface Index {
  rows: Hit[];
  postings: Map<string, Map<number, number>>;
}
const indexes = new WeakMap<object, Index>();
const terms = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Derived solely from the current immutable owner view. No timer or resync. */
export function searchOwnedKnowledge(snapshot: OwnerStateSnapshot, query: string, tags: string[]): Hit[] {
  const view = snapshot.table('sharedMemories');
  let index = indexes.get(view);
  if (!index) {
    index = { rows: [], postings: new Map() };
    for (const doc of view.all()) {
      if (doc.deletedAt) continue;
      const body = snapshot.content('sharedMemories', doc.id, 'content');
      if (typeof body !== 'string') throw new Error('Current knowledge missing from owner state');
      for (const chunk of chunkContent(body)) {
        const row: Hit = {
          memory_id: doc.id,
          ordinal: chunk.ordinal,
          heading: chunk.heading,
          chunk_content: chunk.content,
          char_start: chunk.charStart,
          char_end: chunk.charEnd,
          slug: doc.slug,
          title: doc.title,
          summary: doc.summary,
          tags: doc.tags,
          content_length: doc.contentLength,
          chunk_count: doc.chunkCount,
          revision: doc.revision,
          updated_at: doc.updatedAt,
        };
        const position = index.rows.push(row) - 1;
        const counts = new Map<string, number>();
        for (const term of terms(
          [chunk.content, chunk.heading ?? '', doc.title, doc.tagsText ?? ''].join(' '),
        ))
          counts.set(term, (counts.get(term) ?? 0) + 1);
        for (const [term, count] of counts) {
          let posting = index.postings.get(term);
          if (!posting) {
            posting = new Map();
            index.postings.set(term, posting);
          }
          posting.set(position, count);
        }
      }
    }
    indexes.set(view, index);
  }
  const scores = new Map<number, number>();
  for (const term of new Set(terms(query))) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    const weight = Math.log(1 + index.rows.length / posting.size);
    for (const [position, count] of posting)
      scores.set(position, (scores.get(position) ?? 0) + (1 + Math.log(count)) * weight);
  }
  return [...scores]
    .flatMap(([position, score]) => {
      const row = index!.rows[position]!,
        rowTags = parseTags(row.tags).map((tag) => tag.toLowerCase());
      return tags.every((tag) => rowTags.includes(tag)) ? [{ ...row, score }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.score) - Number(a.score) ||
        String(b.updated_at).localeCompare(String(a.updated_at)) ||
        Number(b.memory_id) - Number(a.memory_id) ||
        Number(a.ordinal) - Number(b.ordinal),
    );
}

type DocumentHit = (Row<'mcpMemories'> | Row<'coordProjectMemories'>) & { score: number };
/** Host/project isolation is applied before scoring or returning current bytes. */
export function searchOwnedMemories(
  snapshot: OwnerStateSnapshot,
  table: 'mcpMemories',
  scopeId: number,
  query: string,
  tags: string[],
): Array<Row<'mcpMemories'> & { score: number }>;
export function searchOwnedMemories(
  snapshot: OwnerStateSnapshot,
  table: 'coordProjectMemories',
  scopeId: number,
  query: string,
  tags: string[],
): Array<Row<'coordProjectMemories'> & { score: number }>;
export function searchOwnedMemories(
  snapshot: OwnerStateSnapshot,
  table: 'mcpMemories' | 'coordProjectMemories',
  scopeId: number,
  query: string,
  tags: string[],
): DocumentHit[] {
  const wanted = new Set(terms(query));
  const rows = snapshot
    .table(table)
    .all()
    .filter(
      (row) =>
        (row as unknown as Record<string, unknown>)[table === 'mcpMemories' ? 'hostId' : 'projectId'] ===
          scopeId &&
        (!('deletedAt' in row) || !row.deletedAt),
    );
  const documents = rows.map((row) => {
    const content = snapshot.content(table, row.id, 'content');
    if (typeof content !== 'string') throw new Error('Current memory missing from owner state');
    const counts = new Map<string, number>();
    for (const term of terms(content + ' ' + (row.tagsText ?? '')))
      counts.set(term, (counts.get(term) ?? 0) + 1);
    return { row, content, counts };
  });
  const weights = new Map(
    [...wanted].map((term) => [
      term,
      Math.log(1 + documents.length / (documents.filter((d) => d.counts.has(term)).length || 1)),
    ]),
  );
  return documents
    .flatMap(({ row, content, counts }) => {
      if (
        !tags.every((tag) =>
          parseTags(row.tags)
            .map((t) => t.toLowerCase())
            .includes(tag),
        )
      )
        return [];
      let score = 0;
      for (const term of wanted) {
        const n = counts.get(term);
        if (n) score += (1 + Math.log(n)) * weights.get(term)!;
      }
      return wanted.size && score === 0 ? [] : [{ ...row, content, score } as DocumentHit];
    })
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
}
