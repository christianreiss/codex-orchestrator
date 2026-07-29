/**
 * Managed importer for Matt Pocock's public engineering/productivity skills.
 *
 * Upstream is treated as untrusted data: the importer resolves `main` to an
 * immutable commit, validates the recursive Git tree and plugin allowlist,
 * downloads text blobs without executing them, then atomically promotes a
 * complete last-known-good snapshot into the fleet skill store.
 */
import { createHash } from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import { TextDecoder } from 'node:util';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { skillFiles, skills, versions } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import { wsPublisher } from '../ws/publisher.js';
import { isManagedSkillSlug } from './managed-skills.js';
import {
  compareUtf8Bytewise,
  computeSkillBundleDigest,
  inspectStoredSkillBundle,
} from './skill-provenance.js';

export const MATTPOCOCK_SOURCE_TYPE = 'github:mattpocock/skills';
export const MATTPOCOCK_SOURCE = MATTPOCOCK_SOURCE_TYPE;
export const MATTPOCOCK_REPOSITORY = 'mattpocock/skills';
export const MATTPOCOCK_REPOSITORY_URL = 'https://github.com/mattpocock/skills';
export const MATTPOCOCK_REF = 'main';
export const MATTPOCOCK_STATE_KEY = 'skill_source_mattpocock_state';

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const PLUGIN_PATH = '.claude-plugin/plugin.json';
const LICENSE_PATH = 'LICENSE';
const BUNDLED_LICENSE_PATH = 'LICENSE.mattpocock';
const SOURCE_LICENSE = 'MIT';
const SHA1_RE = /^[a-f0-9]{40}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PROMOTED_SKILL_RE = /^\.\/skills\/(engineering|productivity)\/([a-z0-9][a-z0-9._-]*)$/;

const MAX_SKILLS = 64;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_JSON_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_LENGTH = 2_000;

type DbLike = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export type MattPocockSourceStatus = 'disabled' | 'ok' | 'error';

export interface MattPocockSkillsState {
  source: string;
  repository: typeof MATTPOCOCK_REPOSITORY_URL;
  ref: typeof MATTPOCOCK_REF;
  enabled: boolean;
  auto_update: boolean;
  status: MattPocockSourceStatus;
  revision: string | null;
  upstream_version: string | null;
  skill_count: number;
  file_count: number;
  last_checked_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

/** Route/worker-facing alias kept deliberately source-agnostic. */
export type SkillSourceState = MattPocockSkillsState;

export interface MattPocockSkillsConfigureInput {
  enabled?: boolean;
  auto_update?: boolean;
}

export interface MattPocockSkillsDependencies {
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
  timeoutMs?: number;
}

interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface ImportedFile {
  path: string;
  sha256: string;
  content: string;
}

interface ImportedSkill {
  slug: string;
  sourcePath: string;
  displayName: string;
  description: string;
  manifest: string;
  manifestSha256: string;
  bundleSha256: string;
  /** Complete delivered bundle, including SKILL.md and the MIT notice. */
  files: ImportedFile[];
}

interface UpstreamSnapshot {
  revision: string;
  upstreamVersion: string | null;
  skills: ImportedSkill[];
  fileCount: number;
}

interface SourceOperationResult {
  state: MattPocockSkillsState;
  skillsChanged: boolean;
  publish: boolean;
  error?: unknown;
}

interface CachedSourceSnapshot {
  rows: Array<typeof skills.$inferSelect>;
}

const SOURCE_TRANSACTION_CONFIG = {
  isolationLevel: 'repeatable read' as const,
};

interface PluginManifest {
  version?: unknown;
  skills?: unknown;
}

interface GitTreeResponse {
  truncated?: unknown;
  tree?: unknown;
}

// `ignoreBOM:true` keeps a leading BOM as content instead of silently
// stripping a byte sequence that was already verified against the Git blob.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Avoid needless in-process lock contention before taking the durable
// `versions` row lock. The database lock is the actual cross-process boundary.
let sourceOperationTail: Promise<void> = Promise.resolve();

async function sourceExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = sourceOperationTail;
  let release!: () => void;
  sourceOperationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function defaultState(): MattPocockSkillsState {
  return {
    source: MATTPOCOCK_SOURCE,
    repository: MATTPOCOCK_REPOSITORY_URL,
    ref: MATTPOCOCK_REF,
    enabled: false,
    auto_update: true,
    status: 'disabled',
    revision: null,
    upstream_version: null,
    skill_count: 0,
    file_count: 0,
    last_checked_at: null,
    last_synced_at: null,
    last_error: null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeStoredState(raw: unknown): MattPocockSkillsState {
  const base = defaultState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  const enabled = value.enabled === true;
  const revision = stringOrNull(value.revision);
  return {
    ...base,
    enabled,
    auto_update: value.auto_update !== false,
    status: value.status === 'error' ? 'error' : enabled ? 'ok' : 'disabled',
    revision: revision && SHA1_RE.test(revision) ? revision : null,
    upstream_version: stringOrNull(value.upstream_version),
    skill_count: nonNegativeInt(value.skill_count),
    file_count: nonNegativeInt(value.file_count),
    last_checked_at: stringOrNull(value.last_checked_at),
    last_synced_at: stringOrNull(value.last_synced_at),
    last_error: stringOrNull(value.last_error),
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function gitBlobSha(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

function rawUrl(revision: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${GITHUB_RAW}/${MATTPOCOCK_REPOSITORY}/${revision}/${encodedPath}`;
}

function isNormalBlob(entry: GitTreeEntry): boolean {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

function isNormalTree(entry: GitTreeEntry): boolean {
  return entry.type === 'tree' && entry.mode === '040000';
}

function normalizeTreeEntry(raw: unknown): GitTreeEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('upstream tree contains an invalid entry');
  }
  const row = raw as Record<string, unknown>;
  const path = typeof row.path === 'string' ? row.path : '';
  const mode = typeof row.mode === 'string' ? row.mode : '';
  const type = typeof row.type === 'string' ? row.type : '';
  const sha = typeof row.sha === 'string' ? row.sha.toLowerCase() : '';
  const size = row.size;
  if (!isSafeRepositoryPath(path) || !SHA1_RE.test(sha)) {
    throw new Error(`upstream tree contains an invalid entry: ${path || '<missing path>'}`);
  }
  if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 0)) {
    throw new Error(`upstream tree contains an invalid size: ${path}`);
  }
  return { path, mode, type, sha, ...(size === undefined ? {} : { size: size as number }) };
}

function isSafeRepositoryPath(path: string): boolean {
  if (path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/')) return false;
  if (path.length > 1_024 || pathPosix.normalize(path) !== path) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function caseFoldPath(path: string): string {
  return path.toLocaleLowerCase('en-US');
}

/** Reject layouts that cannot be represented as one portable file tree. */
function assertPortableBundlePathTopology(paths: string[]): void {
  const originalsByFoldedPath = new Map<string, string>();
  for (const path of paths) {
    const folded = caseFoldPath(path);
    const duplicate = originalsByFoldedPath.get(folded);
    if (duplicate !== undefined) {
      throw new Error(`upstream skill contains a duplicate bundle path: ${duplicate} and ${path}`);
    }
    originalsByFoldedPath.set(folded, path);
  }

  for (const [folded, original] of originalsByFoldedPath) {
    let slash = folded.indexOf('/');
    while (slash !== -1) {
      const prefix = folded.slice(0, slash);
      const prefixOriginal = originalsByFoldedPath.get(prefix);
      if (prefixOriginal !== undefined) {
        throw new Error(
          `upstream skill contains a file/directory bundle path collision: ${prefixOriginal} and ${original}`,
        );
      }
      slash = folded.indexOf('/', slash + 1);
    }
  }
}

function parseYamlScalar(raw: string, field: string): string {
  const value = raw.trim();
  if (value === '' || value === '|' || value === '>' || value === '|-' || value === '>-') {
    throw new Error(`upstream SKILL.md has an unsupported ${field}`);
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'string' && parsed.trim() !== '') return parsed.trim();
    } catch {
      // Fall through to the deterministic validation error below.
    }
    throw new Error(`upstream SKILL.md has an invalid quoted ${field}`);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`upstream SKILL.md has an invalid quoted ${field}`);
    }
    const parsed = value.slice(1, -1).replace(/''/g, "'").trim();
    if (parsed === '') throw new Error(`upstream SKILL.md has an empty ${field}`);
    return parsed;
  }
  return value;
}

function parseSkillFrontmatter(
  manifest: string,
  expectedSlug: string,
): { name: string; description: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(manifest);
  if (!match?.[1]) throw new Error(`upstream skill ${expectedSlug} is missing YAML frontmatter`);
  let name: string | null = null;
  let description: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const keyMatch = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    if (key === 'name') {
      if (name !== null) throw new Error(`upstream skill ${expectedSlug} repeats frontmatter name`);
      name = parseYamlScalar(keyMatch[2] ?? '', 'name');
    } else if (key === 'description') {
      if (description !== null)
        throw new Error(`upstream skill ${expectedSlug} repeats frontmatter description`);
      description = parseYamlScalar(keyMatch[2] ?? '', 'description');
    }
  }
  if (name === null || description === null) {
    throw new Error(`upstream skill ${expectedSlug} requires frontmatter name and description`);
  }
  if (name !== expectedSlug) {
    throw new Error(`upstream skill name ${name} does not match directory slug ${expectedSlug}`);
  }
  return { name, description };
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class MattPocockSkillsService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly clock: () => Date;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Database,
    dependencies: MattPocockSkillsDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.clock = dependencies.clock ?? (() => new Date());
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new Error('Matt Pocock skill source timeout must be between 1 and 120000 ms');
    }
  }

  async getState(): Promise<MattPocockSkillsState> {
    return this.readState(this.db, false);
  }

  async configure(input: MattPocockSkillsConfigureInput): Promise<MattPocockSkillsState> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ValidationError('source settings are required');
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      throw new ValidationError('enabled must be a boolean', { param: 'enabled' });
    }
    if (input.auto_update !== undefined && typeof input.auto_update !== 'boolean') {
      throw new ValidationError('auto_update must be a boolean', { param: 'auto_update' });
    }

    const result = await sourceExclusive(() =>
      this.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const current = await this.readState(tx, true);
        const desiredEnabled = input.enabled ?? current.enabled;
        const desiredAutoUpdate = input.auto_update ?? current.auto_update;

        if (desiredEnabled && !current.enabled) {
          const configuredCurrent = { ...current, auto_update: desiredAutoUpdate };
          const cached = await this.validatedCachedSnapshot(tx, configuredCurrent, false);
          if (cached) {
            const now = this.nowIso();
            const next: MattPocockSkillsState = {
              ...configuredCurrent,
              enabled: true,
              status: 'ok',
              last_error: null,
            };
            for (const row of cached.rows) {
              await tx.update(skills).set({ deletedAt: null, updatedAt: now }).where(eq(skills.id, row.id));
            }
            await this.writeState(tx, next, now);
            return { state: next, skillsChanged: true, publish: true } satisfies SourceOperationResult;
          }

          // Only the first enable (or a damaged cached snapshot) needs GitHub.
          // enabled flips in the same transaction that promotes the snapshot.
          return this.syncUpstreamLocked(tx, configuredCurrent, true, true);
        }

        if (!desiredEnabled && current.enabled) {
          const now = this.nowIso();
          const next: MattPocockSkillsState = {
            ...current,
            enabled: false,
            auto_update: desiredAutoUpdate,
            status: 'disabled',
            last_error: null,
          };
          const owned = await tx.select().from(skills).where(eq(skills.sourceType, MATTPOCOCK_SOURCE_TYPE));
          for (const row of owned) {
            if (row.deletedAt === null) {
              await tx.update(skills).set({ deletedAt: now, updatedAt: now }).where(eq(skills.id, row.id));
            }
          }
          await this.writeState(tx, next, now);
          return { state: next, skillsChanged: true, publish: true } satisfies SourceOperationResult;
        }

        if (desiredAutoUpdate !== current.auto_update) {
          const next = { ...current, auto_update: desiredAutoUpdate };
          await this.writeState(tx, next, this.nowIso());
          return { state: next, skillsChanged: false, publish: true } satisfies SourceOperationResult;
        }
        return { state: current, skillsChanged: false, publish: false } satisfies SourceOperationResult;
      }, SOURCE_TRANSACTION_CONFIG),
    );
    return this.completeOperation(result);
  }

  async refresh(options: { force?: boolean } = {}): Promise<MattPocockSkillsState> {
    const force = options.force === true;
    const result = await sourceExclusive(() =>
      this.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const current = await this.readState(tx, true);
        // Disabled is a hard outbound boundary, including the manual/forced
        // refresh endpoint. Enabling restores its cached LKG or performs the
        // first network import.
        if (!current.enabled) {
          return { state: current, skillsChanged: false, publish: false } satisfies SourceOperationResult;
        }
        if (!force && !current.auto_update) {
          return { state: current, skillsChanged: false, publish: false } satisfies SourceOperationResult;
        }
        return this.syncUpstreamLocked(tx, current, true, force);
      }, SOURCE_TRANSACTION_CONFIG),
    );
    return this.completeOperation(result);
  }

  private async syncUpstreamLocked(
    tx: Database,
    current: MattPocockSkillsState,
    desiredEnabled: boolean,
    force: boolean,
  ): Promise<SourceOperationResult> {
    const checkedAt = this.nowIso();
    try {
      const revision = await this.resolveRevision();
      if (!force && revision === current.revision) {
        const cached = await this.validatedCachedSnapshot(tx, current, desiredEnabled);
        if (cached) {
          const next: MattPocockSkillsState = {
            ...current,
            enabled: desiredEnabled,
            status: desiredEnabled ? 'ok' : 'disabled',
            last_checked_at: checkedAt,
            last_error: null,
          };
          await this.writeState(tx, next, checkedAt);
          return { state: next, skillsChanged: false, publish: true };
        }
        // A matching upstream revision is not enough: rebuild a locally damaged
        // cache from the immutable commit instead of blessing stale digests.
      }

      const snapshot = await this.fetchSnapshot(revision);
      const syncedAt = this.nowIso();
      const next: MattPocockSkillsState = {
        ...current,
        enabled: desiredEnabled,
        status: desiredEnabled ? 'ok' : 'disabled',
        revision: snapshot.revision,
        upstream_version: snapshot.upstreamVersion,
        skill_count: snapshot.skills.length,
        file_count: snapshot.fileCount,
        last_checked_at: checkedAt,
        last_synced_at: syncedAt,
        last_error: null,
      };

      // A savepoint lets the outer source-lock transaction retain its durable
      // lock and record the failed check while guaranteeing that a partially
      // applied skill/file promotion is rolled back first.
      await tx.transaction(async (rawPromotionTx) => {
        const promotionTx = rawPromotionTx as unknown as Database;
        await this.promoteSnapshot(promotionTx, snapshot, desiredEnabled, syncedAt);
        await this.writeState(promotionTx, next, syncedAt);
      });
      return { state: next, skillsChanged: true, publish: true };
    } catch (error) {
      const failed: MattPocockSkillsState = {
        ...current,
        enabled: current.enabled,
        status: 'error',
        last_checked_at: checkedAt,
        last_error: errorMessage(error),
      };
      await this.writeState(tx, failed, checkedAt);
      return { state: failed, skillsChanged: false, publish: true, error };
    }
  }

  private async readState(db: DbLike, lock: boolean): Promise<MattPocockSkillsState> {
    const query = db
      .select({ version: versions.version })
      .from(versions)
      .where(eq(versions.name, MATTPOCOCK_STATE_KEY));
    const rows = lock ? await query.for('update').limit(1) : await query.limit(1);
    const serialized = rows[0]?.version;
    if (typeof serialized !== 'string' || serialized.trim() === '') return defaultState();
    try {
      return normalizeStoredState(JSON.parse(serialized));
    } catch {
      return {
        ...defaultState(),
        status: 'error',
        last_error: 'stored Matt Pocock skill source state is invalid',
      };
    }
  }

  /**
   * Validate the complete cached revision under the caller's transaction
   * snapshot. Rows from older revisions may remain as tombstones; only rows for
   * the state's current revision form the restorable LKG.
   */
  private async validatedCachedSnapshot(
    db: DbLike,
    state: MattPocockSkillsState,
    expectedLive: boolean,
  ): Promise<CachedSourceSnapshot | null> {
    const revision = state.revision;
    if (!revision || !SHA1_RE.test(revision) || state.skill_count < 1) return null;

    const owned = await db.select().from(skills).where(eq(skills.sourceType, MATTPOCOCK_SOURCE_TYPE));
    const currentRows = owned.filter((row) => row.sourceRevision === revision);
    if (currentRows.length !== state.skill_count) return null;
    if (owned.some((row) => row.sourceRevision !== revision && row.deletedAt === null)) return null;
    if (currentRows.some((row) => expectedLive ? row.deletedAt !== null : row.deletedAt === null)) return null;

    const currentIds = new Set(currentRows.map((row) => row.id));
    const allFiles = await db.select().from(skillFiles);
    const files = allFiles.filter((file) => currentIds.has(file.skillId));
    if (currentRows.length + files.length !== state.file_count) return null;

    const filesBySkillId = new Map<number, Array<typeof skillFiles.$inferSelect>>();
    for (const file of files) {
      const grouped = filesBySkillId.get(file.skillId) ?? [];
      grouped.push(file);
      filesBySkillId.set(file.skillId, grouped);
    }
    for (const row of currentRows) {
      if (!inspectStoredSkillBundle(row, filesBySkillId.get(row.id) ?? []).valid) return null;
    }
    return { rows: currentRows };
  }

  private completeOperation(result: SourceOperationResult): MattPocockSkillsState {
    if (result.publish) this.publish(result.skillsChanged, result.state);
    if (result.error !== undefined) throw result.error;
    return result.state;
  }

  private async promoteSnapshot(
    tx: DbLike,
    snapshot: UpstreamSnapshot,
    enabled: boolean,
    now: string,
  ): Promise<void> {
    const existingRows = await tx.select().from(skills);
    const existingBySlug = new Map(existingRows.map((row) => [row.slug, row]));
    for (const incoming of snapshot.skills) {
      if (isManagedSkillSlug(incoming.slug)) {
        throw new Error(`upstream skill slug collides with code-managed skill: ${incoming.slug}`);
      }
      const collision = existingBySlug.get(incoming.slug);
      if (collision && collision.sourceType !== MATTPOCOCK_SOURCE_TYPE) {
        throw new Error(`upstream skill slug collides with fleet-owned skill: ${incoming.slug}`);
      }
    }

    const importedSlugs = new Set(snapshot.skills.map((skill) => skill.slug));
    for (const row of existingRows) {
      if (
        row.sourceType === MATTPOCOCK_SOURCE_TYPE &&
        !importedSlugs.has(row.slug) &&
        row.deletedAt === null
      ) {
        await tx.update(skills).set({ deletedAt: now, updatedAt: now }).where(eq(skills.id, row.id));
      }
    }

    for (const incoming of snapshot.skills) {
      const existing = existingBySlug.get(incoming.slug);
      let skillId: number;
      const skillValues = {
        sha256: incoming.manifestSha256,
        displayName: incoming.displayName,
        description: incoming.description,
        manifest: incoming.manifest,
        sourceHostId: null,
        sourceType: MATTPOCOCK_SOURCE_TYPE,
        sourceRepository: MATTPOCOCK_REPOSITORY_URL,
        sourcePath: incoming.sourcePath,
        sourceRevision: snapshot.revision,
        sourceLicense: SOURCE_LICENSE,
        bundleSha256: incoming.bundleSha256,
        updatedAt: now,
        deletedAt: enabled ? null : now,
        engine: null,
      };
      if (existing) {
        skillId = existing.id;
        await tx.update(skills).set(skillValues).where(eq(skills.id, skillId));
      } else {
        const inserted = await tx.insert(skills).values({
          slug: incoming.slug,
          ...skillValues,
          createdAt: now,
        });
        const rawId = (inserted[0] as { insertId?: number | bigint } | undefined)?.insertId;
        skillId = rawId === undefined ? 0 : Number(rawId);
        if (!Number.isSafeInteger(skillId) || skillId <= 0) {
          throw new Error(`failed to create imported skill row: ${incoming.slug}`);
        }
      }

      await tx.delete(skillFiles).where(eq(skillFiles.skillId, skillId));
      const auxiliary = incoming.files.filter((file) => file.path !== 'SKILL.md');
      if (auxiliary.length > 0) {
        await tx.insert(skillFiles).values(
          auxiliary.map((file) => ({
            skillId,
            path: file.path,
            sha256: file.sha256,
            content: file.content,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
    }
  }

  private async resolveRevision(): Promise<string> {
    const url = `${GITHUB_API}/repos/${MATTPOCOCK_REPOSITORY}/commits/${MATTPOCOCK_REF}`;
    const response = await this.fetchJson<Record<string, unknown>>(url, MAX_GITHUB_JSON_BYTES);
    const revision = typeof response.sha === 'string' ? response.sha.toLowerCase() : '';
    if (!SHA1_RE.test(revision)) throw new Error('GitHub did not resolve main to an immutable commit SHA');
    return revision;
  }

  private async fetchSnapshot(revision: string): Promise<UpstreamSnapshot> {
    if (!SHA1_RE.test(revision)) throw new Error('invalid upstream revision');
    const treeUrl = `${GITHUB_API}/repos/${MATTPOCOCK_REPOSITORY}/git/trees/${revision}?recursive=1`;
    const treeResponse = await this.fetchJson<GitTreeResponse>(treeUrl, MAX_GITHUB_JSON_BYTES);
    if (treeResponse.truncated !== false) throw new Error('GitHub returned a truncated recursive skill tree');
    if (!Array.isArray(treeResponse.tree)) throw new Error('GitHub returned an invalid recursive skill tree');

    const entries = treeResponse.tree.map(normalizeTreeEntry);
    const byPath = new Map<string, GitTreeEntry>();
    for (const entry of entries) {
      if (byPath.has(entry.path)) throw new Error(`upstream tree repeats path: ${entry.path}`);
      byPath.set(entry.path, entry);
    }

    const pluginEntry = byPath.get(PLUGIN_PATH);
    const licenseEntry = byPath.get(LICENSE_PATH);
    if (!pluginEntry || !isNormalBlob(pluginEntry))
      throw new Error('upstream plugin manifest is not a normal blob');
    if (!licenseEntry || !isNormalBlob(licenseEntry))
      throw new Error('upstream LICENSE is not a normal blob');

    const [pluginContent, licenseContent] = await Promise.all([
      this.fetchTreeBlob(revision, pluginEntry),
      this.fetchTreeBlob(revision, licenseEntry),
    ]);
    if (!/\bMIT License\b/.test(licenseContent))
      throw new Error('upstream LICENSE is not the expected MIT license');

    let parsedPlugin: PluginManifest;
    try {
      parsedPlugin = JSON.parse(pluginContent) as PluginManifest;
    } catch {
      throw new Error('upstream plugin manifest is not valid JSON');
    }
    if (!Array.isArray(parsedPlugin.skills))
      throw new Error('upstream plugin manifest has no skills allowlist');
    if (parsedPlugin.skills.length === 0 || parsedPlugin.skills.length > MAX_SKILLS) {
      throw new Error(`upstream plugin manifest must select between 1 and ${MAX_SKILLS} skills`);
    }

    const selected: Array<{ slug: string; directory: string }> = [];
    const seenSlugs = new Set<string>();
    const seenDirectories = new Set<string>();
    for (const rawPath of parsedPlugin.skills) {
      if (typeof rawPath !== 'string') throw new Error('upstream plugin contains a non-string skill path');
      const match = PROMOTED_SKILL_RE.exec(rawPath);
      if (!match?.[2]) {
        throw new Error(`upstream plugin path is outside promoted skill buckets: ${rawPath}`);
      }
      const slug = match[2];
      const directory = rawPath.slice(2);
      if (!SLUG_RE.test(slug) || slug.length > 255)
        throw new Error(`upstream plugin has an invalid skill slug: ${slug}`);
      if (seenSlugs.has(slug)) throw new Error(`upstream plugin repeats skill slug: ${slug}`);
      if (seenDirectories.has(directory)) throw new Error(`upstream plugin repeats skill path: ${rawPath}`);
      seenSlugs.add(slug);
      seenDirectories.add(directory);
      selected.push({ slug, directory });
    }

    const sourceEntries = new Map<string, GitTreeEntry[]>();
    let deliveredFileCount = selected.length; // one copied MIT notice per bundle
    let deliveredBytes = selected.length * licenseContent.length;
    for (const skill of selected) {
      const directoryEntry = byPath.get(skill.directory);
      if (!directoryEntry || !isNormalTree(directoryEntry)) {
        throw new Error(`upstream skill directory is not a normal tree: ${skill.directory}`);
      }
      const prefix = `${skill.directory}/`;
      const descendants = entries.filter((entry) => entry.path.startsWith(prefix));
      const blobs: GitTreeEntry[] = [];
      const relativePaths = new Set<string>();
      for (const entry of descendants) {
        if (isNormalTree(entry)) continue;
        if (!isNormalBlob(entry))
          throw new Error(`upstream skill contains a symlink or non-blob: ${entry.path}`);
        const relativePath = entry.path.slice(prefix.length);
        if (!isSafeRepositoryPath(relativePath) || relativePath.length > 512) {
          throw new Error(`upstream skill contains an unsafe relative path: ${entry.path}`);
        }
        const folded = caseFoldPath(relativePath);
        const firstFoldedSegment = folded.split('/', 1)[0];
        if (firstFoldedSegment === caseFoldPath(BUNDLED_LICENSE_PATH)) {
          throw new Error(`upstream skill contains a reserved bundle path: ${entry.path}`);
        }
        if (relativePaths.has(folded)) {
          throw new Error(`upstream skill contains a duplicate or reserved bundle path: ${entry.path}`);
        }
        relativePaths.add(folded);
        if (entry.size === undefined || entry.size > MAX_FILE_BYTES) {
          throw new Error(`upstream skill file exceeds ${MAX_FILE_BYTES} bytes: ${entry.path}`);
        }
        deliveredFileCount += 1;
        deliveredBytes += entry.size;
        blobs.push(entry);
      }
      assertPortableBundlePathTopology([
        ...blobs.map((entry) => entry.path.slice(prefix.length)),
        BUNDLED_LICENSE_PATH,
      ]);
      if (!blobs.some((entry) => entry.path === `${skill.directory}/SKILL.md`)) {
        throw new Error(`upstream skill is missing SKILL.md: ${skill.slug}`);
      }
      sourceEntries.set(skill.slug, blobs);
    }
    if (deliveredFileCount > MAX_FILES) throw new Error(`upstream skill bundle exceeds ${MAX_FILES} files`);
    if (deliveredBytes > MAX_TOTAL_BYTES)
      throw new Error(`upstream skill bundle exceeds ${MAX_TOTAL_BYTES} bytes`);

    const imported: ImportedSkill[] = [];
    let actualBytes = selected.length * Buffer.byteLength(licenseContent, 'utf8');
    for (const skill of selected.sort((a, b) => compareUtf8Bytewise(a.slug, b.slug))) {
      const blobs = sourceEntries.get(skill.slug) ?? [];
      const fetched = await this.mapLimited(blobs, 8, async (entry): Promise<ImportedFile> => {
        const content = await this.fetchTreeBlob(revision, entry);
        actualBytes += Buffer.byteLength(content, 'utf8');
        return {
          path: entry.path.slice(skill.directory.length + 1),
          sha256: sha256(content),
          content,
        };
      });
      fetched.push({
        path: BUNDLED_LICENSE_PATH,
        sha256: sha256(licenseContent),
        content: licenseContent,
      });
      fetched.sort((a, b) => compareUtf8Bytewise(a.path, b.path));
      const manifest = fetched.find((file) => file.path === 'SKILL.md');
      if (!manifest) throw new Error(`upstream skill is missing fetched SKILL.md: ${skill.slug}`);
      const frontmatter = parseSkillFrontmatter(manifest.content, skill.slug);
      imported.push({
        slug: skill.slug,
        sourcePath: skill.directory,
        displayName: frontmatter.name,
        description: frontmatter.description,
        manifest: manifest.content,
        manifestSha256: manifest.sha256,
        bundleSha256: computeSkillBundleDigest(fetched),
        files: fetched,
      });
    }
    if (actualBytes > MAX_TOTAL_BYTES)
      throw new Error(`upstream skill bundle exceeds ${MAX_TOTAL_BYTES} bytes`);

    const upstreamVersion =
      typeof parsedPlugin.version === 'string' && parsedPlugin.version.trim() !== ''
        ? parsedPlugin.version.trim().slice(0, 128)
        : null;
    return {
      revision,
      upstreamVersion,
      skills: imported,
      fileCount: deliveredFileCount,
    };
  }

  private async fetchTreeBlob(revision: string, entry: GitTreeEntry): Promise<string> {
    if (!isNormalBlob(entry)) throw new Error(`refusing non-blob upstream content: ${entry.path}`);
    if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
      throw new Error(`upstream file exceeds ${MAX_FILE_BYTES} bytes: ${entry.path}`);
    }
    const bytes = await this.fetchBytes(rawUrl(revision, entry.path), MAX_FILE_BYTES);
    if (entry.size !== undefined && bytes.byteLength !== entry.size) {
      throw new Error(`upstream file size does not match Git tree: ${entry.path}`);
    }
    if (gitBlobSha(bytes) !== entry.sha)
      throw new Error(`upstream file does not match Git tree SHA: ${entry.path}`);
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      throw new Error(`upstream file is not UTF-8 text: ${entry.path}`);
    }
  }

  private async fetchJson<T>(url: string, maxBytes: number): Promise<T> {
    const bytes = await this.fetchBytes(url, maxBytes, 'application/vnd.github+json');
    try {
      return JSON.parse(utf8Decoder.decode(bytes)) as T;
    } catch {
      throw new Error(`GitHub returned invalid JSON for ${url}`);
    }
  }

  private async fetchBytes(url: string, maxBytes: number, accept?: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'user-agent': 'codex-orchestrator-skill-source/1',
          ...(accept ? { accept } : {}),
        },
      });
      if (!response.ok) throw new Error(`GitHub fetch failed (${response.status}) for ${url}`);
      const declaredLength = parseContentLength(response);
      if (declaredLength !== null && declaredLength > maxBytes) {
        throw new Error(`GitHub response exceeds ${maxBytes} bytes for ${url}`);
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        length += value.byteLength;
        if (length > maxBytes) {
          controller.abort();
          throw new Error(`GitHub response exceeds ${maxBytes} bytes for ${url}`);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof Error && error.message.includes('exceeds'))) {
        throw new Error(`GitHub fetch timed out for ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async mapLimited<T, R>(
    values: T[],
    concurrency: number,
    mapper: (value: T) => Promise<R>,
  ): Promise<R[]> {
    const output = new Array<R>(values.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        output[index] = await mapper(values[index]!);
      }
    });
    await Promise.all(workers);
    return output;
  }

  private async writeState(db: DbLike, state: MattPocockSkillsState, updatedAt: string): Promise<void> {
    const value = JSON.stringify(state);
    const existing = await db
      .select({ name: versions.name })
      .from(versions)
      .where(eq(versions.name, MATTPOCOCK_STATE_KEY))
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(versions)
        .set({ version: value, updatedAt })
        .where(eq(versions.name, MATTPOCOCK_STATE_KEY));
    } else {
      await db.insert(versions).values({ name: MATTPOCOCK_STATE_KEY, version: value, updatedAt });
    }
  }

  private nowIso(): string {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime()))
      throw new Error('skill source clock returned an invalid date');
    return now.toISOString();
  }

  private publish(skillsChanged: boolean, state: MattPocockSkillsState): void {
    if (skillsChanged) {
      wsPublisher.publish('skill.updated', {
        source: MATTPOCOCK_SOURCE,
        revision: state.revision,
        enabled: state.enabled,
      });
    }
    wsPublisher.publish('settings.changed', { key: MATTPOCOCK_STATE_KEY });
  }
}
