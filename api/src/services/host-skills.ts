/**
 * Host-facing skills service. Mirrors the legacy SkillService for the host
 * surface (list / retrieve / store).
 */
import { eq, asc, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { skills, logs } from '../db/schema.js';
import type { Host } from '../db/schema.js';
import { ConflictError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import type { Engine } from '../util/engine.js';
import { isEngine } from '../util/engine.js';
import {
  getManagedCocoSkillIfEnabled,
  isManagedCocoSlug,
  type ManagedCocoSkill,
} from './managed-coco-skill.js';

const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[a-f0-9]{64}$/i;
const CANONICAL_URI_PREFIX = 'skill://';

function skillUri(slug: string): string {
  return `${CANONICAL_URI_PREFIX}${encodeURIComponent(slug)}`;
}

function normalizeSlug(slug: string): string {
  const normalized = (slug ?? '').trim();
  if (!normalized) throw new ValidationError('Validation failed', { extra: { errors: { slug: ['slug is required'] } } });
  if (normalized.length > 255) {
    throw new ValidationError('Validation failed', { extra: { errors: { slug: ['slug must be 255 characters or fewer'] } } });
  }
  if (normalized.includes('..') || normalized.includes('/')) {
    throw new ValidationError('Validation failed', { extra: { errors: { slug: ['slug cannot include path separators'] } } });
  }
  if (!SLUG_RE.test(normalized)) {
    throw new ValidationError('Validation failed', {
      extra: { errors: { slug: ['slug may only contain letters, numbers, dots, underscores, and hyphens'] } },
    });
  }
  return normalized;
}

function assertSha256(value: unknown, allowNull: boolean, errors: Record<string, string[]> = {}): void {
  if (value === undefined || value === null) {
    if (!allowNull) errors['sha256'] = ['sha256 is required'];
    return;
  }
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    errors['sha256'] = ['sha256 must be a 64-char hex digest'];
  }
}

/** One skill as delivered in the claude on-disk bundle (content omitted on sha match). */
export interface SkillEnvelope {
  slug: string;
  sha256: string;
  status: 'unchanged' | 'updated';
  content?: string;
}

const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/;

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render a skill row as a Claude Code `SKILL.md`. CRITICAL: Claude Code's native
 * skill loader keys off the frontmatter `name:` matching the on-disk slug, so we
 * coerce `name` to the slug (the stored manifest's `name` is the human display
 * name from buildSkillManifest — using it verbatim makes the skill silently
 * invisible). A `description` is ensured (required by Claude Code). The rest of
 * the manifest body is preserved verbatim.
 */
export function renderSkillFile(row: typeof skills.$inferSelect): string {
  const slug = row.slug;
  const description = String(row.description ?? row.displayName ?? slug);
  const manifest = String(row.manifest ?? '');
  const m = FRONTMATTER_RE.exec(manifest);
  if (m && typeof m[1] === 'string') {
    const body = manifest.slice(m[0].length);
    const out: string[] = [];
    let sawName = false;
    let sawDescription = false;
    for (const line of m[1].split('\n')) {
      if (/^name[ \t]*:/.test(line)) {
        out.push(`name: ${slug}`);
        sawName = true;
      } else {
        if (/^description[ \t]*:/.test(line)) sawDescription = true;
        out.push(line);
      }
    }
    if (!sawName) out.unshift(`name: ${slug}`);
    if (!sawDescription) out.push(`description: ${quoteYaml(description)}`);
    return `---\n${out.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`.replace(/\n*$/, '\n');
  }
  return `---\nname: ${slug}\ndescription: ${quoteYaml(description)}\n---\n\n${manifest.replace(/^\n+/, '')}`.replace(
    /\n*$/,
    '\n',
  );
}

export class HostSkillsService {
  constructor(private readonly db: Database) {}

  private async managedCocoSkill(): Promise<ManagedCocoSkill | null> {
    return getManagedCocoSkillIfEnabled(this.db);
  }

  /**
   * Complete live set of skills visible to `engine`, rendered as Claude Code
   * SKILL.md files, for on-disk distribution (claude only — codex reads skills
   * via MCP). `content` is omitted when the wrapper's supplied digest matches the
   * RENDERED file sha. Mirrors HostClaudeArtifactsService.bundle. Note: the sha is
   * computed over the rendered SKILL.md, NOT row.sha256 (which is the raw-manifest
   * sha the MCP/retrieve path depends on).
   */
  async bundle(host: Host, engine: Engine, digests: Record<string, string> = {}): Promise<SkillEnvelope[]> {
    const [rows, managedCoco] = await Promise.all([
      this.db
      .select()
      .from(skills)
      .where(sql`${skills.deletedAt} IS NULL`)
        .orderBy(asc(skills.slug)),
      this.managedCocoSkill(),
    ]);
    const out: SkillEnvelope[] = [];
    for (const row of rows) {
      if (row.deletedAt) continue; // db-fake ignores WHERE — filter in JS too
      if (managedCoco && isManagedCocoSlug(row.slug)) continue;
      const e = row.engine;
      const visible = e === null || e === undefined || e === '' || e === engine;
      if (!visible) continue;
      const content = renderSkillFile(row);
      const sha = createHash('sha256').update(content).digest('hex');
      const have = digests[row.slug];
      const unchanged = typeof have === 'string' && SHA_RE.test(have) && safeHashEquals(sha, have);
      out.push(
        unchanged
          ? { slug: row.slug, sha256: sha, status: 'unchanged' }
          : { slug: row.slug, sha256: sha, status: 'updated', content },
      );
    }
    if (managedCoco) {
      const content = managedCoco.manifest;
      const sha = createHash('sha256').update(content).digest('hex');
      const have = digests[managedCoco.slug];
      const unchanged = typeof have === 'string' && SHA_RE.test(have) && safeHashEquals(sha, have);
      out.push(
        unchanged
          ? { slug: managedCoco.slug, sha256: sha, status: 'unchanged' }
          : { slug: managedCoco.slug, sha256: sha, status: 'updated', content },
      );
    }
    await this.recordLog(host.id, 'skill.bundle', { count: out.length, engine });
    return out;
  }

  async listSkills(host: Host, engine: Engine | null): Promise<{ engine: Engine | null; skills: Record<string, unknown>[] }> {
    const [rows, managedCoco] = await Promise.all([
      this.db
      .select()
      .from(skills)
      .where(sql`${skills.deletedAt} IS NULL`)
        .orderBy(asc(skills.slug)),
      this.managedCocoSkill(),
    ]);
    const filtered = engine && isEngine(engine)
      ? rows.filter((r) => {
          const e = r.engine;
          return e === null || e === undefined || e === '' || e === engine;
        })
      : rows;
    const decorated = filtered
      .filter((r) => !(managedCoco && isManagedCocoSlug(r.slug)))
      .map((r) => this.decorate(r));
    if (managedCoco) decorated.push(this.decorateManaged(managedCoco));
    await this.recordLog(host.id, 'skill.list', { count: decorated.length, engine });
    return { engine, skills: decorated };
  }

  async retrieve(slug: string, providedSha: string | null, host: Host): Promise<Record<string, unknown>> {
    const normalized = normalizeSlug(slug);
    const errors: Record<string, string[]> = {};
    assertSha256(providedSha, true, errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    const managedCoco = isManagedCocoSlug(normalized) ? await this.managedCocoSkill() : null;
    if (managedCoco) {
      const status = providedSha && safeHashEquals(managedCoco.sha256, providedSha) ? 'unchanged' : 'updated';
      await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status, managed: true });
      return {
        status,
        slug: managedCoco.slug,
        uri: managedCoco.uri,
        canonical_uri: managedCoco.canonical_uri,
        sha256: managedCoco.sha256,
        display_name: managedCoco.display_name,
        description: managedCoco.description,
        updated_at: managedCoco.updated_at,
        managed: true,
        ...(status === 'unchanged' ? {} : { manifest: managedCoco.manifest }),
      };
    }

    const found = await this.db.select().from(skills).where(eq(skills.slug, normalized)).limit(1);
    const row = found[0];
    if (!row) {
      await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status: 'missing' });
      return {
        status: 'missing',
        slug: normalized,
        uri: skillUri(normalized),
        canonical_uri: skillUri(normalized),
      };
    }
    if (row.deletedAt) {
      await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status: 'deleted' });
      return {
        status: 'deleted',
        slug: normalized,
        uri: skillUri(normalized),
        canonical_uri: skillUri(normalized),
        deleted_at: row.deletedAt,
      };
    }
    let canonicalSha = row.sha256 ?? '';
    if (!canonicalSha && row.manifest) {
      canonicalSha = createHash('sha256').update(row.manifest).digest('hex');
    }
    const status = providedSha && canonicalSha && safeHashEquals(canonicalSha, providedSha) ? 'unchanged' : 'updated';
    const result: Record<string, unknown> = {
      status,
      slug: normalized,
      uri: skillUri(normalized),
      canonical_uri: skillUri(normalized),
      sha256: canonicalSha,
      display_name: row.displayName ?? null,
      description: row.description ?? null,
      updated_at: row.updatedAt,
      managed: false,
    };
    if (status !== 'unchanged') result['manifest'] = row.manifest ?? '';
    await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status });
    return result;
  }

  async store(payload: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const slugRaw = payload['slug'] ?? payload['filename'] ?? '';
    const manifestRaw = payload['manifest'] ?? payload['content'] ?? '';
    const displayNameRaw = payload['display_name'];
    const descriptionRaw = payload['description'];
    const providedSha = payload['sha256'];

    const slug = normalizeSlug(String(slugRaw));
    if (isManagedCocoSlug(slug) && await this.managedCocoSkill()) {
      throw new ConflictError('managed skill cannot be overwritten directly', 'managed_skill');
    }
    const manifest = String(manifestRaw ?? '').trim() === '' ? '' : String(manifestRaw);
    const errors: Record<string, string[]> = {};
    if (manifest === '') errors['manifest'] = ['manifest is required'];
    assertSha256(typeof providedSha === 'string' ? providedSha : null, true, errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    const sha = createHash('sha256').update(manifest).digest('hex');
    if (typeof providedSha === 'string' && providedSha && !safeHashEquals(sha, providedSha)) {
      throw new ValidationError('Validation failed', { extra: { errors: { sha256: ['sha256 does not match manifest contents'] } } });
    }

    const displayName = displayNameRaw !== undefined && displayNameRaw !== null ? String(displayNameRaw).trim() : null;
    const description = descriptionRaw !== undefined && descriptionRaw !== null ? String(descriptionRaw).trim() : null;

    const existingRows = await this.db.select().from(skills).where(eq(skills.slug, slug)).limit(1);
    const existing = existingRows[0];
    const existingSha = existing?.sha256 ?? null;
    const descriptionToPersist = descriptionRaw === undefined ? (existing?.description ?? null) : description;
    const metadataChanged =
      existing !== undefined &&
      ((existing.displayName ?? null) !== displayName ||
        (existing.description ?? null) !== descriptionToPersist);

    let status: 'created' | 'updated' | 'unchanged' = 'created';
    if (existing) {
      status = existingSha && safeHashEquals(existingSha, sha) && !metadataChanged ? 'unchanged' : 'updated';
    }

    let savedSha = existingSha ?? sha;
    let savedUpdatedAt = existing?.updatedAt ?? null;
    if (status !== 'unchanged') {
      const now = nowIso();
      await this.db
        .insert(skills)
        .values({
          slug,
          sha256: sha,
          displayName,
          description: descriptionToPersist,
          manifest,
          sourceHostId: host.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          engine: existing?.engine ?? null,
        })
        .onDuplicateKeyUpdate({
          set: {
            sha256: sha,
            displayName,
            description: descriptionToPersist,
            manifest,
            sourceHostId: host.id,
            updatedAt: now,
            deletedAt: null,
          },
        });
      savedSha = sha;
      savedUpdatedAt = now;
    }

    await this.recordLog(host.id, 'skill.store', { slug, status });
    wsPublisher.publish(status === 'created' ? 'skill.stored' : 'skill.updated', { slug, source_host_id: host.id });

    return {
      status,
      slug,
      uri: skillUri(slug),
      canonical_uri: skillUri(slug),
      sha256: savedSha,
      updated_at: savedUpdatedAt ?? nowIso(),
      managed: false,
    };
  }

  private decorate(row: typeof skills.$inferSelect): Record<string, unknown> {
    return {
      slug: row.slug,
      sha256: row.sha256 ?? '',
      display_name: row.displayName ?? null,
      description: row.description ?? null,
      updated_at: row.updatedAt,
      deleted_at: row.deletedAt ?? null,
      engine: row.engine ?? null,
      uri: skillUri(row.slug),
      canonical_uri: skillUri(row.slug),
      managed: false,
    };
  }

  private decorateManaged(skill: ManagedCocoSkill): Record<string, unknown> {
    return {
      slug: skill.slug,
      sha256: skill.sha256,
      display_name: skill.display_name,
      description: skill.description,
      updated_at: skill.updated_at,
      deleted_at: null,
      engine: null,
      uri: skill.uri,
      canonical_uri: skill.canonical_uri,
      managed: true,
    };
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

function safeHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
