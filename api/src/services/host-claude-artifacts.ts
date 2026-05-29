/**
 * Host-facing Claude artifact service. Mirrors host-skills.ts for the
 * subagents / slash-commands / output-styles collections.
 *
 * `bundle()` returns the COMPLETE live set per kind so the wrapper can reconcile
 * deletions (anything in its on-disk manifest but absent from the live set gets
 * removed). `content` is omitted for items whose sha matches the wrapper's
 * supplied digest (If-None-Match), so an unchanged fleet is one cheap round-trip.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { claudeArtifacts, logs } from '../db/schema.js';
import type { ClaudeArtifact, Host } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { isEngine, type Engine } from '../util/engine.js';
import { ARTIFACT_KINDS, type ArtifactKind, normalizeSlug } from './claude-frontmatter.js';

const SHA_RE = /^[a-f0-9]{64}$/i;

export interface ArtifactEnvelope {
  slug: string;
  sha256: string;
  status: 'unchanged' | 'updated';
  content?: string;
}

export type ArtifactDigestMap = Partial<Record<ArtifactKind, Record<string, string>>>;
export type ArtifactBundle = Record<ArtifactKind, ArtifactEnvelope[]>;

function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export class HostClaudeArtifactsService {
  constructor(private readonly db: Database) {}

  private engineMatches(rowEngine: string | null, engine: Engine | null): boolean {
    if (!engine || !isEngine(engine)) return true;
    return rowEngine === null || rowEngine === undefined || rowEngine === '' || rowEngine === engine;
  }

  // kind/deletedAt filtered in SQL (real DB) and again in JS so the in-memory
  // test shim (whose `.where()` is a no-op) stays correct.
  private async liveRows(kind: ArtifactKind): Promise<ClaudeArtifact[]> {
    const rows = await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), isNull(claudeArtifacts.deletedAt)))
      .orderBy(asc(claudeArtifacts.slug));
    return rows.filter((r) => r.kind === kind && !r.deletedAt).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async list(
    kind: ArtifactKind,
    host: Host,
    engine: Engine | null,
  ): Promise<{ kind: ArtifactKind; engine: Engine | null; items: Record<string, unknown>[] }> {
    const rows = (await this.liveRows(kind)).filter((r) => this.engineMatches(r.engine, engine));
    const items = rows.map((r) => ({
      slug: r.slug,
      sha256: r.sha256,
      display_name: r.displayName ?? null,
      description: r.description ?? null,
      model: r.model ?? null,
      updated_at: r.updatedAt,
      engine: r.engine ?? null,
    }));
    await this.recordLog(host.id, 'claude_artifact.list', { kind, count: items.length, engine });
    return { kind, engine, items };
  }

  async retrieve(
    kind: ArtifactKind,
    rawSlug: string,
    providedSha: string | null,
    host: Host,
  ): Promise<Record<string, unknown>> {
    const slug = normalizeSlug(rawSlug);
    if (providedSha !== null && providedSha !== undefined && !SHA_RE.test(providedSha)) {
      throw new ValidationError('Validation failed', {
        extra: { errors: { sha256: ['sha256 must be a 64-char hex digest'] } },
      });
    }
    const rows = await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), eq(claudeArtifacts.slug, slug)));
    const row = rows.find((r) => r.kind === kind && r.slug === slug);
    if (!row) {
      await this.recordLog(host.id, 'claude_artifact.retrieve', { kind, slug, status: 'missing' });
      return { status: 'missing', kind, slug };
    }
    if (row.deletedAt) {
      await this.recordLog(host.id, 'claude_artifact.retrieve', { kind, slug, status: 'deleted' });
      return { status: 'deleted', kind, slug, deleted_at: row.deletedAt };
    }
    const status = providedSha && safeHashEquals(row.sha256, providedSha) ? 'unchanged' : 'updated';
    const result: Record<string, unknown> = {
      status,
      kind,
      slug,
      sha256: row.sha256,
      display_name: row.displayName ?? null,
      description: row.description ?? null,
      model: row.model ?? null,
      updated_at: row.updatedAt,
    };
    if (status !== 'unchanged') result['content'] = row.body;
    await this.recordLog(host.id, 'claude_artifact.retrieve', { kind, slug, status });
    return result;
  }

  /**
   * Complete live set per kind, engine-scoped, with content omitted on sha
   * match. `digests` is the wrapper's on-disk {kind: {slug: sha}} map.
   */
  async bundle(host: Host, engine: Engine, digests: ArtifactDigestMap = {}): Promise<ArtifactBundle> {
    const out = {} as ArtifactBundle;
    for (const kind of ARTIFACT_KINDS) {
      const have = digests[kind] ?? {};
      const rows = (await this.liveRows(kind)).filter((r) => this.engineMatches(r.engine, engine));
      out[kind] = rows.map((r) => {
        const known = have[r.slug];
        const unchanged = typeof known === 'string' && SHA_RE.test(known) && safeHashEquals(r.sha256, known);
        const env: ArtifactEnvelope = { slug: r.slug, sha256: r.sha256, status: unchanged ? 'unchanged' : 'updated' };
        if (!unchanged) env.content = r.body;
        return env;
      });
    }
    return out;
  }

  async store(payload: Record<string, unknown>, kind: ArtifactKind, host: Host): Promise<Record<string, unknown>> {
    // Host-originated upsert reuses the admin service contract via a thin shim;
    // kept here so the host route does not depend on the admin service module.
    const slug = normalizeSlug(String(payload['slug'] ?? payload['filename'] ?? ''));
    await this.recordLog(host.id, 'claude_artifact.store', { kind, slug, status: 'received' });
    // Delegate-free path: persist directly with the same dedup contract.
    const body = typeof payload['body'] === 'string' ? payload['body'] : typeof payload['content'] === 'string' ? (payload['content'] as string) : '';
    if (body.trim() === '') throw new ValidationError('body is required', { param: 'body' });
    const sha = createHash('sha256').update(body).digest('hex');
    const now = nowIso();
    await this.db
      .insert(claudeArtifacts)
      .values({ kind, slug, sha256: sha, body, sourceHostId: host.id, createdAt: now, updatedAt: now, engine: null })
      .onDuplicateKeyUpdate({ set: { sha256: sha, body, sourceHostId: host.id, updatedAt: now, deletedAt: null } });
    return { status: 'ok', kind, slug, sha256: sha, updated_at: now };
  }

  private async recordLog(hostId: number | null, action: string, details: Record<string, unknown>): Promise<void> {
    await this.db.insert(logs).values({
      hostId: hostId ?? null,
      action,
      details: JSON.stringify(details),
      createdAt: nowIso(),
      engine: null,
    });
  }
}
