/**
 * Skills domain service. Port of src/Services/SkillService.php (admin slice).
 *
 * - listSkills() returns every row (optionally including soft-deleted).
 * - find() returns one skill by slug (with manifest body).
 * - store() upserts a manifest, validating slug + sha256 + manifest body.
 * - deleteBySlug() soft-deletes via `deleted_at`.
 *
 * Every mutation publishes a WS event so the frontend can invalidate caches.
 */
import { and, eq, isNull, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { skills } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { canonicalSkillUri, normalizeSlug } from './skill-manifest.js';
import { isManagedCocoSlug } from './managed-coco-skill.js';

export interface SkillView {
  id: number;
  slug: string;
  uri: string;
  canonical_uri: string;
  sha256: string;
  display_name: string | null;
  description: string | null;
  manifest: string;
  source_host_id: number | null;
  engine: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StoreSkillInput {
  slug?: unknown;
  filename?: unknown;
  manifest?: unknown;
  content?: unknown;
  display_name?: unknown;
  description?: unknown;
  sha256?: unknown;
  engine?: unknown;
}

export interface StoreSkillResult {
  status: 'created' | 'updated' | 'unchanged';
  slug: string;
  uri: string;
  canonical_uri: string;
  sha256: string;
  updated_at: string;
  managed: false;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function toView(row: typeof skills.$inferSelect): SkillView {
  const slug = row.slug;
  return {
    id: row.id,
    slug,
    uri: canonicalSkillUri(slug),
    canonical_uri: canonicalSkillUri(slug),
    sha256: row.sha256,
    display_name: row.displayName,
    description: row.description,
    manifest: row.manifest,
    source_host_id: row.sourceHostId,
    engine: row.engine,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
  };
}

export class SkillsService {
  constructor(private readonly db: Database) {}

  async list(opts: { includeDeleted?: boolean } = {}): Promise<SkillView[]> {
    const includeDeleted = opts.includeDeleted ?? false;
    const rows = includeDeleted
      ? await this.db.select().from(skills).orderBy(skills.slug)
      : await this.db.select().from(skills).where(isNull(skills.deletedAt)).orderBy(skills.slug);
    return rows.map(toView);
  }

  async find(rawSlug: string): Promise<SkillView | null> {
    const slug = normalizeSlug(rawSlug);
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.slug, slug))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toView(row);
  }

  async store(input: StoreSkillInput, sourceHostId: number | null = null): Promise<StoreSkillResult> {
    const slug = normalizeSlug(input.slug ?? input.filename);
    if (isManagedCocoSlug(slug)) {
      throw new ConflictError('managed skill cannot be stored directly', 'managed_skill');
    }
    const manifest = typeof input.manifest === 'string'
      ? input.manifest
      : typeof input.content === 'string'
        ? input.content
        : '';
    if (manifest.trim() === '') {
      throw new ValidationError('manifest is required', { param: 'manifest' });
    }
    const displayName = typeof input.display_name === 'string'
      ? input.display_name.trim() || null
      : null;
    const descriptionRaw = input.description;
    const description = typeof descriptionRaw === 'string'
      ? descriptionRaw.trim() || null
      : descriptionRaw === null
        ? null
        : undefined;
    const engine = typeof input.engine === 'string' && input.engine.trim() !== ''
      ? input.engine.trim()
      : null;

    const computedSha = sha256Hex(manifest);
    if (typeof input.sha256 === 'string' && input.sha256.trim() !== '') {
      const provided = input.sha256.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(provided)) {
        throw new ValidationError('sha256 must be 64 hex characters', { param: 'sha256' });
      }
      if (provided !== computedSha) {
        throw new ValidationError('sha256 does not match manifest contents', { param: 'sha256' });
      }
    }

    const existingRows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.slug, slug))
      .limit(1);
    const existing = existingRows[0];
    const nowTs = nowIso();

    if (!existing) {
      await this.db.insert(skills).values({
        slug,
        sha256: computedSha,
        displayName,
        description: description ?? null,
        manifest,
        sourceHostId,
        engine,
        createdAt: nowTs,
        updatedAt: nowTs,
      });
      wsPublisher.publish('skill.stored', { slug, status: 'created' });
      wsPublisher.publish('skill.updated', { slug });
      return {
        status: 'created',
        slug,
        uri: canonicalSkillUri(slug),
        canonical_uri: canonicalSkillUri(slug),
        sha256: computedSha,
        updated_at: nowTs,
        managed: false,
      };
    }

    const persistedDescription = description === undefined ? existing.description : description;
    const metadataUnchanged = existing.displayName === displayName
      && existing.description === persistedDescription
      && existing.engine === engine;
    const shaUnchanged = existing.sha256 === computedSha;

    if (shaUnchanged && metadataUnchanged) {
      return {
        status: 'unchanged',
        slug,
        uri: canonicalSkillUri(slug),
        canonical_uri: canonicalSkillUri(slug),
        sha256: existing.sha256,
        updated_at: existing.updatedAt,
        managed: false,
      };
    }

    await this.db
      .update(skills)
      .set({
        sha256: computedSha,
        displayName,
        description: persistedDescription,
        manifest,
        sourceHostId,
        engine,
        updatedAt: nowTs,
        deletedAt: null,
      })
      .where(eq(skills.id, existing.id));

    wsPublisher.publish('skill.stored', { slug, status: 'updated' });
    wsPublisher.publish('skill.updated', { slug });

    return {
      status: 'updated',
      slug,
      uri: canonicalSkillUri(slug),
      canonical_uri: canonicalSkillUri(slug),
      sha256: computedSha,
      updated_at: nowTs,
      managed: false,
    };
  }

  /**
   * Soft-delete via `deleted_at`. Returns false if no live row matched.
   * Throws ConflictError if the slug is reserved (managed skills).
   */
  async softDelete(rawSlug: string): Promise<boolean> {
    const slug = normalizeSlug(rawSlug);
    if (isManagedCocoSlug(slug)) {
      throw new ConflictError('managed skill cannot be deleted directly', 'managed_skill');
    }
    if (slug.startsWith('codex-') || slug.startsWith('claude-')) {
      // The legacy ProjectModuleService reserved certain slugs as managed.
      // We don't manage anything here in admin-content, but we surface a
      // clear error if callers hit those names.
      if (slug === 'codex-project-coordination' || slug === 'claude-project-coordination') {
        throw new ConflictError('managed skill cannot be deleted directly', 'managed_skill');
      }
    }

    const rows = await this.db
      .select()
      .from(skills)
      .where(and(eq(skills.slug, slug), isNull(skills.deletedAt)))
      .limit(1);
    const existing = rows[0];
    if (!existing) return false;

    const nowTs = nowIso();
    await this.db
      .update(skills)
      .set({ deletedAt: nowTs, updatedAt: nowTs })
      .where(eq(skills.id, existing.id));

    wsPublisher.publish('skill.deleted', { slug });
    return true;
  }

  async requireBySlug(rawSlug: string): Promise<SkillView> {
    const found = await this.find(rawSlug);
    if (!found) throw new NotFoundError('Skill not found', 'skill_not_found');
    return found;
  }

  /**
   * Used by the admin overview: the most recently updated skill row.
   */
  async latestUpdated(): Promise<SkillView | null> {
    const rows = await this.db
      .select()
      .from(skills)
      .orderBy(desc(skills.updatedAt))
      .limit(1);
    const row = rows[0];
    return row ? toView(row) : null;
  }
}
