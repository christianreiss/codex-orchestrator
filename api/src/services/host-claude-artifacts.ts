import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import { publicArtifact } from '../control-plane/state/artifact-content.js';
import type { StateRow } from '../control-plane/state/catalog.js';
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
import type { Database } from '../db/client.js';
import { claudeArtifacts } from '../db/schema.js';
import type { ClaudeArtifact, Host } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
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
  // test fake (whose `.where()` is a no-op) stays correct.
  private async content(row:StateRow<'claudeArtifacts'>|ClaudeArtifact):Promise<string>{
    const owner=ownerRuntimeFor(this.db);if(!owner)return (row as ClaudeArtifact).body;
    return publicArtifact(owner,`claude-artifact:${row.id}:${row.sha256}`,async()=>{const [body]=await this.db.select({body:claudeArtifacts.body,sha256:claudeArtifacts.sha256}).from(claudeArtifacts).where(eq(claudeArtifacts.id,row.id)).limit(1);if(!body||body.sha256!==row.sha256)throw new Error('Claude artifact changed');return body.body;},()=>owner.state.snapshot().table('claudeArtifacts').get(row.id)?.sha256===row.sha256&&!owner.state.snapshot().table('claudeArtifacts').get(row.id)?.deletedAt);
  }
  private async liveRows(kind: ArtifactKind): Promise<Array<StateRow<'claudeArtifacts'>|ClaudeArtifact>> {
    const owner=ownerRuntimeFor(this.db);if(owner){owner.assertOwner();return owner.state.snapshot().table('claudeArtifacts').by('kind',kind).filter(row=>!row.deletedAt).sort((a,b)=>a.slug.localeCompare(b.slug));}

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
    const owner=ownerRuntimeFor(this.db);owner?.assertOwner();
    const rows = owner?owner.state.snapshot().table('claudeArtifacts').by('kind',kind):await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), eq(claudeArtifacts.slug, slug)));
    const row = rows.find((r) => r.kind === kind && r.slug === slug);
    if (!row) {
      return { status: 'missing', kind, slug };
    }
    if (row.deletedAt) {
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
    if (status !== 'unchanged') result['content'] = await this.content(row);
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
      out[kind] = await Promise.all(rows.map(async (r) => {
        const known = have[r.slug];
        const unchanged = typeof known === 'string' && SHA_RE.test(known) && safeHashEquals(r.sha256, known);
        const env: ArtifactEnvelope = { slug: r.slug, sha256: r.sha256, status: unchanged ? 'unchanged' : 'updated' };
        if (!unchanged) env.content = await this.content(r);
        return env;
      }));
    }
    return out;
  }


}
