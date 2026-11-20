import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
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
import { isEngine, type Engine } from '../util/engine.js';
import { ARTIFACT_KINDS, type ArtifactKind } from './claude-frontmatter.js';

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
  private async content(row: StateRow<'claudeArtifacts'> | ClaudeArtifact): Promise<string> {
    const owner = ownerRuntimeFor(this.db);
    if (!owner) return (row as ClaudeArtifact).body;
    owner.assertOwner();
    const body = owner.state.snapshot().content('claudeArtifacts', row.id, 'body');
    if (typeof body !== 'string') throw new Error('Current Claude artifact missing from owner state');
    return body;
  }
  private async liveRows(kind: ArtifactKind): Promise<Array<StateRow<'claudeArtifacts'> | ClaudeArtifact>> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      owner.assertOwner();
      return owner.state
        .snapshot()
        .table('claudeArtifacts')
        .by('kind', kind)
        .filter((row) => !row.deletedAt)
        .sort((a, b) => a.slug.localeCompare(b.slug));
    }

    const rows = await this.db
      .select()
      .from(claudeArtifacts)
      .where(and(eq(claudeArtifacts.kind, kind), isNull(claudeArtifacts.deletedAt)))
      .orderBy(asc(claudeArtifacts.slug));
    return rows.filter((r) => r.kind === kind && !r.deletedAt).sort((a, b) => a.slug.localeCompare(b.slug));
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
      out[kind] = await Promise.all(
        rows.map(async (r) => {
          const known = have[r.slug];
          const unchanged =
            typeof known === 'string' && SHA_RE.test(known) && safeHashEquals(r.sha256, known);
          const env: ArtifactEnvelope = {
            slug: r.slug,
            sha256: r.sha256,
            status: unchanged ? 'unchanged' : 'updated',
          };
          if (!unchanged) env.content = await this.content(r);
          return env;
        }),
      );
    }
    return out;
  }
}
