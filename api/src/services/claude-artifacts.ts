/**
 * Claude-Code artifact admin service (subagents / slash-commands / output-styles).
 *
 * One table discriminated by `kind`, mirroring the skills lifecycle: build a
 * canonical `.md` body from structured frontmatter fields (or a pasted raw body),
 * sha256-dedup, upsert on (kind, slug), soft-delete via `deleted_at`. Every
 * mutation publishes a WS event so the admin UI invalidates its caches.
 *
 * The canonical body is what hosts receive and hash; per-artifact `model` is a
 * frontmatter field baked into that body once at store time, so the sha is
 * identical for every fleet host (the bundle's If-None-Match dedup relies on it).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { claudeArtifacts } from '../db/schema.js';
import type { ClaudeArtifact } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import {
  type ArtifactKind,
  normalizeSlug,
  parseFrontmatter,
  serializeFrontmatter,
  validateForKind,
} from './claude-frontmatter.js';

export interface ArtifactView {
  id: number;
  kind: ArtifactKind;
  slug: string;
  sha256: string;
  display_name: string | null;
  description: string | null;
  model: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  source_host_id: number | null;
  engine: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StoreArtifactInput {
  slug?: unknown;
  filename?: unknown;
  body?: unknown;
  content?: unknown;
  frontmatter?: unknown;
  // Structured frontmatter fields (override anything parsed from `body`):
  name?: unknown;
  description?: unknown;
  model?: unknown;
  color?: unknown;
  argument_hint?: unknown;
  tools?: unknown;
  allowed_tools?: unknown;
  disallowed_tools?: unknown;
  sha256?: unknown;
  engine?: unknown;
}

export interface StoreArtifactResult {
  status: 'created' | 'updated' | 'unchanged';
  kind: ArtifactKind;
  slug: string;
  sha256: string;
  updated_at: string;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function asStringList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter((x) => x !== '');
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '');
  }
  return undefined;
}

function asTrimmedString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

// ────────────────────────────────────────────────────────────────────────────
// Duplicate-key detection (store() TOCTOU on the `uq_claude_artifacts_kind_slug`
// unique index — same pattern as host-management.ts's isDuplicateFqdnError)
// ────────────────────────────────────────────────────────────────────────────
function isDuplicateSlugError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown; sqlMessage?: unknown };
  const isDupEntry = e.code === 'ER_DUP_ENTRY' || e.errno === 1062;
  if (!isDupEntry) return false;
  const msg = `${typeof e.sqlMessage === 'string' ? e.sqlMessage : ''} ${
    typeof e.message === 'string' ? e.message : ''
  }`.toLowerCase();
  return msg.includes('kind_slug');
}

function toView(row: ClaudeArtifact): ArtifactView {
  return {
    id: row.id,
    kind: row.kind as ArtifactKind,
    slug: row.slug,
    sha256: row.sha256,
    display_name: row.displayName,
    description: row.description,
    model: row.model,
    frontmatter: (row.frontmatter as Record<string, unknown>) ?? {},
    body: row.body,
    source_host_id: row.sourceHostId,
    engine: row.engine,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
  };
}

/**
 * Build the canonical frontmatter object from a (possibly frontmatter-bearing)
 * raw body plus explicit structured fields. Explicit fields win.
 */
function buildArtifact(
  kind: ArtifactKind,
  slug: string,
  input: StoreArtifactInput,
): { body: string; frontmatter: Record<string, unknown> } {
  const raw = typeof input.body === 'string' ? input.body : typeof input.content === 'string' ? input.content : '';
  const { frontmatter: parsedFm, content } = parseFrontmatter(raw);

  const fm: Record<string, unknown> = { ...parsedFm };
  if (input.frontmatter && typeof input.frontmatter === 'object' && !Array.isArray(input.frontmatter)) {
    Object.assign(fm, input.frontmatter as Record<string, unknown>);
  }

  const setIf = (key: string, v: unknown) => {
    if (v !== undefined) fm[key] = v;
  };
  setIf('name', asTrimmedString(input.name));
  setIf('description', asTrimmedString(input.description));
  setIf('model', asTrimmedString(input.model));
  setIf('color', asTrimmedString(input.color));
  setIf('argument-hint', asTrimmedString(input.argument_hint));
  setIf('tools', asStringList(input.tools));
  setIf('allowed-tools', asStringList(input.allowed_tools));
  setIf('disallowed-tools', asStringList(input.disallowed_tools));

  // Subagents are identified by their `name`; default it to the slug so the
  // file the wrapper writes (`<slug>.md`) and the agent identity stay aligned.
  if (kind === 'subagent' && asTrimmedString(fm['name']) === undefined) {
    fm['name'] = slug;
  }
  if (kind === 'output-style' && asTrimmedString(fm['name']) === undefined && asTrimmedString(input.name) !== undefined) {
    fm['name'] = asTrimmedString(input.name);
  }

  validateForKind(kind, fm);
  const body = serializeFrontmatter(fm, content);
  return { body, frontmatter: fm };
}

export class ClaudeArtifactsService {
  constructor(private readonly db: Database) {}

  // Note: kind/deletedAt are filtered both in SQL (real DB) and in JS. The JS
  // pass is a no-op against MySQL (already filtered) but keeps the in-memory
  // test fake — whose `.where()` is a no-op — correct.
  private async rowsForKind(kind: ArtifactKind, includeDeleted: boolean): Promise<ClaudeArtifact[]> {
    const rows = await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), includeDeleted ? undefined : isNull(claudeArtifacts.deletedAt)))
      .orderBy(asc(claudeArtifacts.slug));
    return rows
      .filter((r) => r.kind === kind && (includeDeleted || !r.deletedAt))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async list(kind: ArtifactKind, opts: { includeDeleted?: boolean } = {}): Promise<ArtifactView[]> {
    const rows = await this.rowsForKind(kind, opts.includeDeleted ?? false);
    return rows.map(toView);
  }

  async find(kind: ArtifactKind, rawSlug: string): Promise<ArtifactView | null> {
    const slug = normalizeSlug(rawSlug);
    const rows = await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), eq(claudeArtifacts.slug, slug)));
    const row = rows.find((r) => r.kind === kind && r.slug === slug);
    return row ? toView(row) : null;
  }

  async requireBySlug(kind: ArtifactKind, rawSlug: string): Promise<ArtifactView> {
    const found = await this.find(kind, rawSlug);
    if (!found) throw new NotFoundError('artifact not found', 'artifact_not_found');
    return found;
  }

  async store(
    kind: ArtifactKind,
    input: StoreArtifactInput,
    sourceHostId: number | null = null,
  ): Promise<StoreArtifactResult> {
    const slug = normalizeSlug(input.slug ?? input.filename);
    const { body, frontmatter } = buildArtifact(kind, slug, input);
    if (body.trim() === '') throw new ValidationError('artifact body is required', { param: 'body' });

    const computedSha = sha256Hex(body);
    if (typeof input.sha256 === 'string' && input.sha256.trim() !== '') {
      const provided = input.sha256.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(provided)) {
        throw new ValidationError('sha256 must be 64 hex characters', { param: 'sha256' });
      }
      if (provided !== computedSha) {
        throw new ValidationError('sha256 does not match artifact contents', { param: 'sha256' });
      }
    }

    const displayName = asTrimmedString(frontmatter['name']) ?? null;
    const description = asTrimmedString(frontmatter['description']) ?? null;
    const model = asTrimmedString(frontmatter['model']) ?? null;
    const engine = asTrimmedString(input.engine) ?? null;

    const existingRows = await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), eq(claudeArtifacts.slug, slug)));
    let existing = existingRows.find((r) => r.kind === kind && r.slug === slug);
    const nowTs = nowIso();

    if (!existing) {
      try {
        await this.db.insert(claudeArtifacts).values({
          kind,
          slug,
          sha256: computedSha,
          displayName,
          description,
          model,
          frontmatter,
          body,
          sourceHostId,
          engine,
          createdAt: nowTs,
          updatedAt: nowTs,
        });
        wsPublisher.publish('claude_artifact.stored', { kind, slug, status: 'created' });
        wsPublisher.publish('claude_artifact.updated', { kind, slug });
        return { status: 'created', kind, slug, sha256: computedSha, updated_at: nowTs };
      } catch (err) {
        if (!isDuplicateSlugError(err)) throw err;
        // Lost a race with a concurrent first-time store() for this (kind, slug):
        // the other insert won the unique index, so re-fetch and fall through
        // to the update path below instead of leaking the raw DB error.
        const raceRows = await this.db
          .select()
          .from(claudeArtifacts)
          .where(and(eq(claudeArtifacts.kind, kind), eq(claudeArtifacts.slug, slug)));
        existing = raceRows.find((r) => r.kind === kind && r.slug === slug);
        if (!existing) throw err;
      }
    }

    const metadataUnchanged =
      existing.displayName === displayName &&
      existing.description === description &&
      existing.model === model &&
      existing.engine === engine &&
      !existing.deletedAt;
    if (existing.sha256 === computedSha && metadataUnchanged) {
      return { status: 'unchanged', kind, slug, sha256: existing.sha256, updated_at: existing.updatedAt };
    }

    await this.db
      .update(claudeArtifacts)
      .set({
        sha256: computedSha,
        displayName,
        description,
        model,
        frontmatter,
        body,
        sourceHostId,
        engine,
        updatedAt: nowTs,
        deletedAt: null,
      })
      .where(eq(claudeArtifacts.id, existing.id));

    wsPublisher.publish('claude_artifact.stored', { kind, slug, status: 'updated' });
    wsPublisher.publish('claude_artifact.updated', { kind, slug });
    return { status: 'updated', kind, slug, sha256: computedSha, updated_at: nowTs };
  }

  /** Soft-delete via `deleted_at`. Returns false if no live row matched. */
  async softDelete(kind: ArtifactKind, rawSlug: string): Promise<boolean> {
    const slug = normalizeSlug(rawSlug);
    const rows = await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), eq(claudeArtifacts.slug, slug), isNull(claudeArtifacts.deletedAt)));
    const existing = rows.find((r) => r.kind === kind && r.slug === slug && !r.deletedAt);
    if (!existing) return false;

    const nowTs = nowIso();
    await this.db
      .update(claudeArtifacts)
      .set({ deletedAt: nowTs, updatedAt: nowTs })
      .where(eq(claudeArtifacts.id, existing.id));
    wsPublisher.publish('claude_artifact.deleted', { kind, slug });
    return true;
  }
}
