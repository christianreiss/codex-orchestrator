/**
 * Host-facing skills service. Mirrors the legacy SkillService for the host
 * surface (list / retrieve / store).
 */
import { eq, asc, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { skills, skillFiles, logs } from '../db/schema.js';
import type { Host } from '../db/schema.js';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CODEX } from '../util/engine.js';
import { findManagedSkill, listManagedSkills, type ManagedSkillManifest } from './managed-skills.js';
import {
  allowsImplicitSkillInvocation,
  effectiveSkillDigest,
  inspectStoredSkillBundle,
  isSourceOwnedSkill,
  skillProvenanceView,
} from './skill-provenance.js';

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
  manifest_sha256?: string;
  files?: SkillFileView[];
}

export interface SkillFileSummary {
  path: string;
  sha256: string;
}

export interface SkillFileView extends SkillFileSummary {
  content: string;
}

interface StoredSkillSnapshot {
  row: typeof skills.$inferSelect;
  files: SkillFileView[];
}

interface LiveSkillSnapshot {
  rows: Array<typeof skills.$inferSelect>;
  filesBySkillId: Map<number, SkillFileView[]>;
}

const READ_SNAPSHOT_CONFIG = {
  isolationLevel: 'repeatable read' as const,
  withConsistentSnapshot: true,
};

const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/;

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function visibleToEngine(row: typeof skills.$inferSelect, engine: Engine): boolean {
  const rowEngine = row.engine;
  return rowEngine === null || rowEngine === undefined || rowEngine === '' || rowEngine === engine;
}

function normalizeSkillFilePath(raw: string): string {
  const path = (raw ?? '').trim();
  const segments = path.split('/');
  if (
    path === ''
    || path.length > 512
    || path.includes('\\')
    || path.startsWith('/')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ValidationError('invalid skill file path', { param: 'path' });
  }
  return path;
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

  /** Every code-derived skill currently served (coco when enabled, context always). */
  private async managedSkills(): Promise<ManagedSkillManifest[]> {
    return listManagedSkills(this.db);
  }

  /**
   * Number of effective, non-deleted skills visible to an engine. This is a
   * diagnostics/capability read: unlike listSkills(), it deliberately emits no
   * host activity log and selects metadata only, because AGENTS/CLAUDE
   * rendering calls it on every sync and must not load full Skill bundles.
   */
  async availableCount(engine: Engine): Promise<number> {
    const [stored, managed] = await Promise.all([
      this.db
        .select({ slug: skills.slug, deletedAt: skills.deletedAt, engine: skills.engine })
        .from(skills)
        .where(sql`${skills.deletedAt} IS NULL`),
      this.managedSkills(),
    ]);
    const managedSlugs = new Set(managed.map((skill) => skill.slug));
    // Keep the JS filters for db-fake and make engine-null rows shared.
    const storedCount = stored.filter((row) =>
      !row.deletedAt
      && (row.engine === null || row.engine === undefined || row.engine === '' || row.engine === engine)
      && !managedSlugs.has(row.slug)
    ).length;
    return storedCount + managed.length;
  }

  /**
   * Complete live set of skills visible to `engine`, rendered as Claude Code
   * SKILL.md files, for on-disk distribution (claude only — codex reads skills
   * via MCP). `content` is omitted when the wrapper's supplied digest matches the
   * host-facing change digest. Source-owned bundles prefer `bundle_sha256` so a
   * referenced file change invalidates the wrapper cache; ordinary rows retain
   * the rendered SKILL.md sha used historically. Mirrors
   * HostClaudeArtifactsService.bundle.
  */
  async bundle(host: Host, engine: Engine, digests: Record<string, string> = {}): Promise<SkillEnvelope[]> {
    const [snapshot, managed] = await Promise.all([
      this.readLiveSnapshot(engine),
      this.managedSkills(),
    ]);
    const { rows, filesBySkillId } = snapshot;
    const managedSlugs = new Set(managed.map((m) => m.slug));
    const out: SkillEnvelope[] = [];
    for (const row of rows) {
      if (row.deletedAt) continue; // db-fake ignores WHERE — filter in JS too
      if (managedSlugs.has(row.slug)) continue; // code-derived version wins
      // Source adapters validate that the upstream frontmatter name already
      // matches the slug, so preserve their signed/hashed SKILL.md byte-for-byte.
      // Locally authored legacy rows still need the historical Claude name
      // coercion performed by renderSkillFile.
      const content = isSourceOwnedSkill(row) ? row.manifest : renderSkillFile(row);
      const renderedSha = createHash('sha256').update(content).digest('hex');
      const sha = effectiveSkillDigest(row, renderedSha);
      const have = digests[row.slug];
      const unchanged = typeof have === 'string' && SHA_RE.test(have) && safeHashEquals(sha, have.toLowerCase());
      out.push(
        unchanged
          ? { slug: row.slug, sha256: sha, status: 'unchanged' }
          : {
              slug: row.slug,
              sha256: sha,
              status: 'updated',
              content,
              ...(isSourceOwnedSkill(row)
                ? { manifest_sha256: renderedSha, files: filesBySkillId.get(row.id) ?? [] }
                : {}),
            },
      );
    }
    for (const m of managed) {
      const content = m.manifest;
      const sha = createHash('sha256').update(content).digest('hex');
      const have = digests[m.slug];
      const unchanged = typeof have === 'string' && SHA_RE.test(have) && safeHashEquals(sha, have.toLowerCase());
      out.push(
        unchanged
          ? { slug: m.slug, sha256: sha, status: 'unchanged' }
          : { slug: m.slug, sha256: sha, status: 'updated', content },
      );
    }
    await this.recordLog(host.id, 'skill.bundle', { count: out.length, engine });
    return out;
  }

  async listSkills(host: Host, engine: Engine | null): Promise<{ engine: Engine | null; skills: Record<string, unknown>[] }> {
    const [snapshot, managed] = await Promise.all([
      this.readLiveSnapshot(engine),
      this.managedSkills(),
    ]);
    const { rows } = snapshot;
    const managedSlugs = new Set(managed.map((m) => m.slug));
    const decorated = rows
      .filter((r) => !managedSlugs.has(r.slug))
      .map((r) => this.decorate(r));
    for (const m of managed) decorated.push(this.decorateManaged(m));
    await this.recordLog(host.id, 'skill.list', { count: decorated.length, engine });
    return { engine, skills: decorated };
  }

  /** Metadata-only listing for support files attached to one live skill. */
  async listFiles(
    rawSlug: string,
    host: Host,
    engine: Engine = ENGINE_CODEX,
  ): Promise<SkillFileSummary[]> {
    const snapshot = await this.requireStoredSkillSnapshot(rawSlug, engine);
    const out = snapshot.files.map((file) => ({ path: file.path, sha256: file.sha256 }));
    await this.recordLog(host.id, 'skill.file.list', { slug: snapshot.row.slug, count: out.length, engine });
    return out;
  }

  /** Read one exact support file. Paths are relative and traversal-free. */
  async retrieveFile(
    rawSlug: string,
    rawPath: string,
    host: Host,
    engine: Engine = ENGINE_CODEX,
  ): Promise<SkillFileView> {
    const snapshot = await this.requireStoredSkillSnapshot(rawSlug, engine);
    const path = normalizeSkillFilePath(rawPath);
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file) throw new NotFoundError('Skill file not found', 'skill_file_not_found');
    await this.recordLog(host.id, 'skill.file.retrieve', { slug: snapshot.row.slug, path, engine });
    return { path: file.path, sha256: file.sha256, content: file.content };
  }

  async retrieve(
    slug: string,
    providedSha: string | null,
    host: Host,
    engine: Engine = ENGINE_CODEX,
  ): Promise<Record<string, unknown>> {
    const normalized = normalizeSlug(slug);
    const errors: Record<string, string[]> = {};
    assertSha256(providedSha, true, errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    const managed = await findManagedSkill(this.db, normalized);
    if (managed) {
      const status = providedSha && safeHashEquals(managed.sha256, providedSha.toLowerCase()) ? 'unchanged' : 'updated';
      await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status, managed: true });
      return {
        status,
        slug: managed.slug,
        uri: managed.uri,
        canonical_uri: managed.canonical_uri,
        sha256: managed.sha256,
        manifest_sha256: managed.sha256,
        display_name: managed.display_name,
        description: managed.description,
        updated_at: managed.updated_at,
        allow_implicit_invocation: allowsImplicitSkillInvocation(managed.manifest),
        managed: true,
        ...skillProvenanceView({}),
        ...(status === 'unchanged' ? {} : { manifest: managed.manifest }),
      };
    }

    const snapshot = await this.readStoredSkillSnapshot(normalized, engine);
    const row = snapshot?.row;
    if (!row) {
      await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status: 'missing', engine });
      return {
        status: 'missing',
        slug: normalized,
        uri: skillUri(normalized),
        canonical_uri: skillUri(normalized),
      };
    }
    if (row.deletedAt) {
      await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status: 'deleted', engine });
      return {
        status: 'deleted',
        slug: normalized,
        uri: skillUri(normalized),
        canonical_uri: skillUri(normalized),
        deleted_at: row.deletedAt,
        allow_implicit_invocation: allowsImplicitSkillInvocation(row.manifest ?? ''),
        managed: isSourceOwnedSkill(row),
        ...skillProvenanceView(row),
      };
    }
    let manifestSha = row.sha256 ?? '';
    if (!manifestSha && row.manifest) {
      manifestSha = createHash('sha256').update(row.manifest).digest('hex');
    }
    const canonicalSha = effectiveSkillDigest(row, manifestSha);
    const status = providedSha && canonicalSha && safeHashEquals(canonicalSha, providedSha.toLowerCase()) ? 'unchanged' : 'updated';
    const result: Record<string, unknown> = {
      status,
      slug: normalized,
      uri: skillUri(normalized),
      canonical_uri: skillUri(normalized),
      sha256: canonicalSha,
      manifest_sha256: manifestSha,
      display_name: row.displayName ?? null,
      description: row.description ?? null,
      updated_at: row.updatedAt,
      allow_implicit_invocation: allowsImplicitSkillInvocation(row.manifest ?? ''),
      managed: isSourceOwnedSkill(row),
      ...skillProvenanceView(row),
    };
    if (status !== 'unchanged') result['manifest'] = row.manifest ?? '';
    await this.recordLog(host.id, 'skill.retrieve', { slug: normalized, status, engine });
    return result;
  }

  async store(payload: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const slugRaw = payload['slug'] ?? payload['filename'] ?? '';
    const manifestRaw = payload['manifest'] ?? payload['content'] ?? '';
    const displayNameRaw = payload['display_name'];
    const descriptionRaw = payload['description'];
    const providedSha = payload['sha256'];

    const slug = normalizeSlug(String(slugRaw));
    if (await findManagedSkill(this.db, slug)) {
      throw new ConflictError('managed skill cannot be overwritten directly', 'managed_skill');
    }
    const manifest = String(manifestRaw ?? '').trim() === '' ? '' : String(manifestRaw);
    const errors: Record<string, string[]> = {};
    if (manifest === '') errors['manifest'] = ['manifest is required'];
    assertSha256(typeof providedSha === 'string' ? providedSha : null, true, errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    const sha = createHash('sha256').update(manifest).digest('hex');
    if (typeof providedSha === 'string' && providedSha && !safeHashEquals(sha, providedSha.toLowerCase())) {
      throw new ValidationError('Validation failed', { extra: { errors: { sha256: ['sha256 does not match manifest contents'] } } });
    }

    const displayName = displayNameRaw !== undefined && displayNameRaw !== null ? String(displayNameRaw).trim() : null;
    const description = descriptionRaw !== undefined && descriptionRaw !== null ? String(descriptionRaw).trim() : null;

    // The unique slug lookup is a locking read. Under REPEATABLE READ it locks
    // either the existing row or the unique-index gap, so an importer cannot
    // insert a source-owned row between the ownership check and this write.
    const persisted = await this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(skills)
        .where(eq(skills.slug, slug))
        .for('update')
        .limit(1);
      const existing = existingRows[0];
      if (existing && isSourceOwnedSkill(existing)) {
        throw new ConflictError('source-managed skill cannot be overwritten directly', 'managed_skill');
      }

      const existingSha = existing?.sha256 ?? null;
      const descriptionToPersist = descriptionRaw === undefined ? (existing?.description ?? null) : description;
      const metadataChanged =
        existing !== undefined &&
        ((existing.displayName ?? null) !== displayName ||
          (existing.description ?? null) !== descriptionToPersist);
      const status: 'created' | 'updated' | 'unchanged' = existing
        ? existingSha && safeHashEquals(existingSha, sha) && !metadataChanged ? 'unchanged' : 'updated'
        : 'created';

      if (status === 'unchanged') {
        return { status, savedSha: existingSha ?? sha, savedUpdatedAt: existing?.updatedAt ?? nowIso() };
      }

      const now = nowIso();
      if (existing) {
        await tx
          .update(skills)
          .set({
            sha256: sha,
            displayName,
            description: descriptionToPersist,
            manifest,
            sourceHostId: host.id,
            updatedAt: now,
            deletedAt: null,
          })
          .where(eq(skills.id, existing.id));
      } else {
        await tx.insert(skills).values({
          slug,
          sha256: sha,
          displayName,
          description: descriptionToPersist,
          manifest,
          sourceHostId: host.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          engine: null,
        });
      }
      return { status, savedSha: sha, savedUpdatedAt: now };
    }, { isolationLevel: 'repeatable read' });

    await this.recordLog(host.id, 'skill.store', { slug, status: persisted.status });
    wsPublisher.publish(persisted.status === 'created' ? 'skill.stored' : 'skill.updated', { slug, source_host_id: host.id });

    return {
      status: persisted.status,
      slug,
      uri: skillUri(slug),
      canonical_uri: skillUri(slug),
      sha256: persisted.savedSha,
      updated_at: persisted.savedUpdatedAt,
      managed: false,
    };
  }

  private decorate(row: typeof skills.$inferSelect): Record<string, unknown> {
    return {
      slug: row.slug,
      sha256: effectiveSkillDigest(row, row.sha256 ?? ''),
      manifest_sha256: row.sha256 ?? '',
      display_name: row.displayName ?? null,
      description: row.description ?? null,
      updated_at: row.updatedAt,
      allow_implicit_invocation: allowsImplicitSkillInvocation(row.manifest ?? ''),
      deleted_at: row.deletedAt ?? null,
      engine: row.engine ?? null,
      uri: skillUri(row.slug),
      canonical_uri: skillUri(row.slug),
      managed: isSourceOwnedSkill(row),
      ...skillProvenanceView(row),
    };
  }

  private async readLiveSnapshot(engine: Engine | null): Promise<LiveSkillSnapshot> {
    return this.db.transaction(async (tx) => {
      const selected = await tx
        .select()
        .from(skills)
        .where(sql`${skills.deletedAt} IS NULL`)
        .orderBy(asc(skills.slug));
      // Keep the JS deleted filter for db-fake and make the engine boundary part
      // of the snapshot before any source bundle is validated or exposed.
      const rows = selected.filter((row) => !row.deletedAt && (!engine || visibleToEngine(row, engine)));
      const sourceSkillIds = new Set(rows.filter(isSourceOwnedSkill).map((row) => row.id));
      const filesBySkillId = new Map<number, SkillFileView[]>();
      if (sourceSkillIds.size > 0) {
        const files = await tx.select().from(skillFiles).orderBy(asc(skillFiles.path));
        for (const file of files) {
          if (!sourceSkillIds.has(file.skillId)) continue;
          const grouped = filesBySkillId.get(file.skillId) ?? [];
          grouped.push({ path: file.path, sha256: file.sha256, content: file.content });
          filesBySkillId.set(file.skillId, grouped);
        }
      }
      for (const row of rows) {
        if (isSourceOwnedSkill(row)) this.assertSourceBundle(row, filesBySkillId.get(row.id) ?? []);
      }
      return { rows, filesBySkillId };
    }, READ_SNAPSHOT_CONFIG);
  }

  private async readStoredSkillSnapshot(slug: string, engine: Engine): Promise<StoredSkillSnapshot | null> {
    return this.db.transaction(async (tx) => {
      const found = await tx.select().from(skills).where(eq(skills.slug, slug)).limit(1);
      const row = found[0];
      if (!row || !visibleToEngine(row, engine)) return null;
      if (row.deletedAt) return { row, files: [] };
      const selectedFiles = await tx
        .select()
        .from(skillFiles)
        .where(eq(skillFiles.skillId, row.id))
        .orderBy(asc(skillFiles.path));
      const files = selectedFiles.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        content: file.content,
      }));
      if (isSourceOwnedSkill(row)) this.assertSourceBundle(row, files);
      return { row, files };
    }, READ_SNAPSHOT_CONFIG);
  }

  private async requireStoredSkillSnapshot(rawSlug: string, engine: Engine): Promise<StoredSkillSnapshot> {
    const slug = normalizeSlug(rawSlug);
    if (await findManagedSkill(this.db, slug)) {
      throw new NotFoundError('Skill has no stored support files', 'skill_file_not_found');
    }
    const snapshot = await this.readStoredSkillSnapshot(slug, engine);
    if (!snapshot || snapshot.row.deletedAt) throw new NotFoundError('Skill not found', 'skill_not_found');
    return snapshot;
  }

  private assertSourceBundle(row: typeof skills.$inferSelect, files: SkillFileView[]): void {
    const integrity = inspectStoredSkillBundle(row, files);
    if (!integrity.valid) {
      throw new ServiceUnavailableError(
        `Stored source skill bundle failed integrity validation: ${row.slug} (${integrity.reason ?? 'unknown'})`,
        'skill_bundle_invalid',
      );
    }
  }

  private decorateManaged(skill: ManagedSkillManifest): Record<string, unknown> {
    return {
      slug: skill.slug,
      sha256: skill.sha256,
      display_name: skill.display_name,
      description: skill.description,
      updated_at: skill.updated_at,
      allow_implicit_invocation: allowsImplicitSkillInvocation(skill.manifest),
      deleted_at: null,
      engine: null,
      uri: skill.uri,
      canonical_uri: skill.canonical_uri,
      managed: true,
      manifest_sha256: skill.sha256,
      source_type: null,
      source_repository: null,
      source_path: null,
      source_revision: null,
      source_license: null,
      bundle_sha256: null,
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
