/**
 * Skills domain service. Port of src/Services/SkillService.php (admin slice).
 *
 * - list() returns every row (optionally including soft-deleted) plus the
 *   code-derived managed skills, which shadow same-named rows.
 * - find() returns one skill by slug (with manifest body).
 * - store() upserts a manifest, validating slug + sha256 + manifest body.
 * - deleteBySlug() soft-deletes via `deleted_at`.
 *
 * Every mutation publishes a WS event so the frontend can invalidate caches.
 */
import { eq, isNull, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { skills } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { canonicalSkillUri, normalizeSlug } from './skill-manifest.js';
import { findManagedSkill, isManagedSkillSlug, listManagedSkills, type ManagedSkillManifest } from './managed-skills.js';
import {
  allowsImplicitSkillInvocation,
  isSourceOwnedSkill,
  skillProvenanceView,
  type SkillProvenanceView,
} from './skill-provenance.js';

export interface SkillView extends SkillProvenanceView {
  id: number | null;
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
  allow_implicit_invocation: boolean;
  /** True when code or an external source owns the row; direct mutations are rejected. */
  managed: boolean;
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

const MUTATION_TRANSACTION_CONFIG = { isolationLevel: 'repeatable read' as const };

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
    allow_implicit_invocation: allowsImplicitSkillInvocation(row.manifest),
    managed: isManagedSkillSlug(slug) || isSourceOwnedSkill(row),
    ...skillProvenanceView(row),
  };
}

/**
 * A code-derived skill as an admin entry. `id` is null because there is no row
 * behind it to edit: the manifest ships with the API image, and store/delete
 * reject the slug.
 */
function managedToView(skill: ManagedSkillManifest): SkillView {
  return {
    id: null,
    slug: skill.slug,
    uri: skill.uri,
    canonical_uri: skill.canonical_uri,
    sha256: skill.sha256,
    display_name: skill.display_name,
    description: skill.description,
    manifest: skill.manifest,
    source_host_id: null,
    engine: skill.engine,
    created_at: skill.updated_at,
    updated_at: skill.updated_at,
    deleted_at: skill.deleted_at,
    allow_implicit_invocation: allowsImplicitSkillInvocation(skill.manifest),
    managed: true,
    source_type: null,
    source_repository: null,
    source_path: null,
    source_revision: null,
    source_license: null,
    bundle_sha256: null,
  };
}

export class SkillsService {
  constructor(private readonly db: Database) {}

  /**
   * Ordinary rows plus the code-derived skills hosts actually receive. A row
   * whose slug is served by a managed skill is replaced by that manifest rather
   * than listed next to it: showing both is how `#context` ended up with two
   * disagreeing versions and no way to tell which one hosts were running.
   */
  async list(opts: { includeDeleted?: boolean } = {}): Promise<SkillView[]> {
    const includeDeleted = opts.includeDeleted ?? false;
    const [rows, managed] = await Promise.all([
      includeDeleted
        ? this.db.select().from(skills).orderBy(skills.slug)
        : this.db.select().from(skills).where(isNull(skills.deletedAt)).orderBy(skills.slug),
      listManagedSkills(this.db),
    ]);
    const bySlug = new Map(managed.map((m) => [m.slug, m]));
    const shadowed = new Set<string>();
    const out: SkillView[] = [];
    for (const row of rows) {
      const served = bySlug.get(row.slug);
      if (!served) {
        out.push(toView(row));
        continue;
      }
      shadowed.add(row.slug);
      out.push(managedToView(served));
    }
    for (const m of managed) {
      if (!shadowed.has(m.slug)) out.push(managedToView(m));
    }
    out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    return out;
  }

  async find(rawSlug: string): Promise<SkillView | null> {
    const slug = normalizeSlug(rawSlug);
    const managed = await findManagedSkill(this.db, slug);
    if (managed) return managedToView(managed);
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
    if (isManagedSkillSlug(slug)) {
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

    // The unique slug lookup is a locking read. Under REPEATABLE READ it locks
    // either the existing row or the unique-index gap, so source promotion
    // cannot change ownership between this check and the write.
    const result = await this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(skills)
        .where(eq(skills.slug, slug))
        .for('update')
        .limit(1);
      const existing = existingRows[0];
      if (existing && isSourceOwnedSkill(existing)) {
        throw new ConflictError('source-managed skill cannot be stored directly', 'managed_skill');
      }

      const nowTs = nowIso();
      if (!existing) {
        await tx.insert(skills).values({
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
        return {
          status: 'created' as const,
          slug,
          uri: canonicalSkillUri(slug),
          canonical_uri: canonicalSkillUri(slug),
          sha256: computedSha,
          updated_at: nowTs,
          managed: false as const,
        };
      }

      const persistedDescription = description === undefined ? existing.description : description;
      const metadataUnchanged = existing.displayName === displayName
        && existing.description === persistedDescription
        && existing.engine === engine;
      const shaUnchanged = existing.sha256 === computedSha;

      if (shaUnchanged && metadataUnchanged) {
        return {
          status: 'unchanged' as const,
          slug,
          uri: canonicalSkillUri(slug),
          canonical_uri: canonicalSkillUri(slug),
          sha256: existing.sha256,
          updated_at: existing.updatedAt,
          managed: false as const,
        };
      }

      await tx
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

      return {
        status: 'updated' as const,
        slug,
        uri: canonicalSkillUri(slug),
        canonical_uri: canonicalSkillUri(slug),
        sha256: computedSha,
        updated_at: nowTs,
        managed: false as const,
      };
    }, MUTATION_TRANSACTION_CONFIG);

    if (result.status !== 'unchanged') {
      wsPublisher.publish('skill.stored', { slug, status: result.status });
      wsPublisher.publish('skill.updated', { slug });
    }
    return result;
  }

  /**
   * Soft-delete via `deleted_at`. Returns false if no live row matched.
   * Throws ConflictError if the slug is reserved (managed skills).
   */
  async softDelete(rawSlug: string): Promise<boolean> {
    const slug = normalizeSlug(rawSlug);
    if (isManagedSkillSlug(slug)) {
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

    const deleted = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(skills)
        .where(eq(skills.slug, slug))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (existing && isSourceOwnedSkill(existing)) {
        throw new ConflictError('source-managed skill cannot be deleted directly', 'managed_skill');
      }
      if (!existing || existing.deletedAt) return false;

      const nowTs = nowIso();
      await tx
        .update(skills)
        .set({ deletedAt: nowTs, updatedAt: nowTs })
        .where(eq(skills.id, existing.id));
      return true;
    }, MUTATION_TRANSACTION_CONFIG);

    if (deleted) wsPublisher.publish('skill.deleted', { slug });
    return deleted;
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
