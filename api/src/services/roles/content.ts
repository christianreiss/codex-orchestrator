import { roleContext, roleState } from './owner.js';
/**
 * Role package content: content-addressed blobs, the file list of one version,
 * its bundle digest and the activation payload built from it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  agentRoleBlobs,
  agentRoleVersionFiles,
  type AgentRole,
  type AgentRoleVersion,
} from '../../db/schema.js';
import type { AgentMessagingDb } from '../agent-messaging/types.js';
import { ValidationError } from '../../http/errors.js';
import { sha256 } from '../../security/hash.js';
import { nowIso } from '../../util/timestamp.js';
import { acceptFileBody, inferMimeType, FILE_ENCODING_UTF8 } from '../project-file-encoding.js';
import {
  ROLE_CORE_MAX_BYTES,
  ROLE_LOAD_MODES,
  ROLE_MANIFEST_PATH,
  ROLE_MAX_FILES,
  ROLE_VERSION_MAX_BYTES,
  normalizeRolePath,
  parseRoleManifest,
  roleUri,
  type RoleLoadMode,
} from './contract.js';

export type RoleDb = AgentMessagingDb;

/** One file entry as it is stored on a version, before or after insert. */
export interface RoleFileEntry {
  path: string;
  blob_sha256: string;
  mime_type: string;
  load: RoleLoadMode;
  description: string | null;
  introduced_in_version: number | null;
  source_proposal_id: string | null;
  size_bytes: number;
  encoding: string;
}

/** A file as a caller supplies it: either a body, or a blob it already references. */
export interface RoleFileInput {
  path: unknown;
  content?: unknown;
  encoding?: unknown;
  blob_sha256?: unknown;
  mime_type?: unknown;
  load?: unknown;
  description?: unknown;
}

export function normalizeLoad(value: unknown): RoleLoadMode {
  if (value === undefined || value === null || value === '') return 'on_demand';
  if (!ROLE_LOAD_MODES.includes(value as RoleLoadMode))
    throw new ValidationError('load must be core or on_demand', { param: 'load' });
  return value as RoleLoadMode;
}

/** Store a body once, keyed by the digest of its decoded bytes. */
export async function putBlob(
  db: RoleDb,
  content: string,
  encoding: unknown,
): Promise<{ sha256: string; size_bytes: number; encoding: string }> {
  const accepted = acceptFileBody(content, encoding);
  if (!accepted.ok) throw new ValidationError(accepted.error.message, { param: accepted.error.field });
  const { body, sha256: digest, sizeBytes, encoding: stored } = accepted.value;
  const ctx = roleContext();
  if (ctx) {
    ctx.blobs.set(digest, { content: body, encoding: stored, size_bytes: sizeBytes });
    ctx.command.write(async (tx) =>
      tx
        .insert(agentRoleBlobs)
        .values({ sha256: digest, encoding: stored, content: body, sizeBytes, createdAt: nowIso() })
        .onDuplicateKeyUpdate({ set: { sha256: digest } }),
    );
    return { sha256: digest, size_bytes: sizeBytes, encoding: stored };
  }
  await db
    .insert(agentRoleBlobs)
    .values({ sha256: digest, encoding: stored, content: body, sizeBytes, createdAt: nowIso() })
    .onDuplicateKeyUpdate({ set: { sha256: digest } });
  return { sha256: digest, size_bytes: sizeBytes, encoding: stored };
}

export async function blobMeta(
  db: RoleDb,
  shas: string[],
): Promise<Map<string, { size_bytes: number; encoding: string }>> {
  if (!shas.length) return new Map();
  const staged = roleContext()?.blobs;
  const missing = shas.filter((sha) => !staged?.has(sha));
  if (staged && missing.length !== shas.length) {
    const found = await blobMeta(db, missing);
    for (const sha of shas) {
      const value = staged.get(sha);
      if (value) found.set(sha, { size_bytes: value.size_bytes, encoding: value.encoding });
    }
    return found;
  }
  const rows = await db
    .select({
      sha256: agentRoleBlobs.sha256,
      sizeBytes: agentRoleBlobs.sizeBytes,
      encoding: agentRoleBlobs.encoding,
    })
    .from(agentRoleBlobs)
    .where(inArray(agentRoleBlobs.sha256, [...new Set(shas)]));
  return new Map(rows.map((row) => [row.sha256, { size_bytes: row.sizeBytes, encoding: row.encoding }]));
}

export async function readBlob(
  db: RoleDb,
  sha: string,
): Promise<{ content: string; encoding: string } | null> {
  const staged = roleContext()?.blobs.get(sha);
  if (staged) return { content: staged.content, encoding: staged.encoding };
  const [row] = await db.select().from(agentRoleBlobs).where(eq(agentRoleBlobs.sha256, sha)).limit(1);
  return row ? { content: row.content, encoding: row.encoding } : null;
}

/** Turn caller input into stored entries; a referenced blob must already exist. */
export async function acceptFiles(db: RoleDb, files: unknown): Promise<RoleFileEntry[]> {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new ValidationError('files must be a list', { param: 'files' });
  if (files.length > ROLE_MAX_FILES)
    throw new ValidationError(`a role version holds at most ${ROLE_MAX_FILES} files`, { param: 'files' });
  const out: RoleFileEntry[] = [];
  const seen = new Set<string>();
  for (const raw of files as RoleFileInput[]) {
    const path = normalizeRolePath(raw?.path);
    if (seen.has(path)) throw new ValidationError(`duplicate file path ${path}`, { param: 'files' });
    seen.add(path);
    let blob: { sha256: string; size_bytes: number; encoding: string };
    if (typeof raw.content === 'string') {
      blob = await putBlob(db, raw.content, raw.encoding);
    } else if (typeof raw.blob_sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.blob_sha256)) {
      const meta = (await blobMeta(db, [raw.blob_sha256])).get(raw.blob_sha256);
      if (!meta) throw new ValidationError(`unknown blob for ${path}`, { param: 'files' });
      blob = { sha256: raw.blob_sha256, ...meta };
    } else {
      throw new ValidationError(`file ${path} needs content or blob_sha256`, { param: 'files' });
    }
    const mime =
      typeof raw.mime_type === 'string' && raw.mime_type.trim()
        ? raw.mime_type.trim().slice(0, 127)
        : (inferMimeType(path) ??
          (blob.encoding === FILE_ENCODING_UTF8 ? 'text/plain' : 'application/octet-stream'));
    out.push({
      path,
      blob_sha256: blob.sha256,
      mime_type: mime,
      load: normalizeLoad(raw.load),
      description:
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim().slice(0, 300)
          : null,
      introduced_in_version: null,
      source_proposal_id: null,
      size_bytes: blob.size_bytes,
      encoding: blob.encoding,
    });
  }
  return out;
}

export async function versionFiles(db: RoleDb, versionId: string): Promise<RoleFileEntry[]> {
  const state = roleState(db);
  const rows = state
    ? state
        .table('agentRoleVersionFiles')
        .all()
        .filter((row) => row.versionId === versionId)
    : await db.select().from(agentRoleVersionFiles).where(eq(agentRoleVersionFiles.versionId, versionId));
  const meta = await blobMeta(
    db,
    rows.map((row) => row.blobSha256),
  );
  return rows
    .map((row) => ({
      path: row.path,
      blob_sha256: row.blobSha256,
      mime_type: row.mimeType,
      load: row.loadMode as RoleLoadMode,
      description: row.description,
      introduced_in_version: row.introducedInVersion,
      source_proposal_id: row.sourceProposalId,
      size_bytes: meta.get(row.blobSha256)?.size_bytes ?? 0,
      encoding: meta.get(row.blobSha256)?.encoding ?? FILE_ENCODING_UTF8,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function writeVersionFiles(
  db: RoleDb,
  versionId: string,
  files: RoleFileEntry[],
): Promise<void> {
  const ctx = roleContext();
  if (ctx) {
    for (const row of ctx.command.draft.table('agentRoleVersionFiles').all())
      if (row.versionId === versionId) ctx.command.draft.remove('agentRoleVersionFiles', row.id);
    ctx.command.write(async (tx) =>
      tx.delete(agentRoleVersionFiles).where(eq(agentRoleVersionFiles.versionId, versionId)),
    );
    for (const file of files) {
      const row = {
        versionId,
        path: file.path,
        blobSha256: file.blob_sha256,
        mimeType: file.mime_type,
        loadMode: file.load,
        description: file.description,
        introducedInVersion: file.introduced_in_version,
        sourceProposalId: file.source_proposal_id,
      };
      const temporary = ctx.nextFileId--;
      ctx.command.draft.upsert('agentRoleVersionFiles', { ...row, id: temporary });
      ctx.command.write(async (tx) => {
        const [inserted] = await tx.insert(agentRoleVersionFiles).values(row);
        if (ctx.command.draft.table('agentRoleVersionFiles').has(temporary)) {
          ctx.command.draft.remove('agentRoleVersionFiles', temporary);
          ctx.command.draft.upsert('agentRoleVersionFiles', { ...row, id: Number(inserted.insertId) });
        }
      });
    }
    return;
  }
  await db.delete(agentRoleVersionFiles).where(eq(agentRoleVersionFiles.versionId, versionId));
  if (!files.length) return;
  await db.insert(agentRoleVersionFiles).values(
    files.map((file) => ({
      versionId,
      path: file.path,
      blobSha256: file.blob_sha256,
      mimeType: file.mime_type,
      loadMode: file.load,
      description: file.description,
      introducedInVersion: file.introduced_in_version,
      sourceProposalId: file.source_proposal_id,
    })),
  );
}

/** Same construction as a skill bundle: the manifest is one more sorted entry. */
export function bundleDigest(
  manifestSha: string,
  files: Array<{ path: string; blob_sha256: string }>,
): string {
  const entries = [
    { path: ROLE_MANIFEST_PATH, sha: manifestSha },
    ...files.map((file) => ({ path: file.path, sha: file.blob_sha256 })),
  ]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => `${entry.path}\0${entry.sha}\n`)
    .join('');
  return sha256(entries);
}

/**
 * Every rule a version must meet before it can be published, whoever publishes
 * it: a parseable manifest naming the role, and the core and total budgets.
 */
export function assertPublishable(slug: string, manifest: string, files: RoleFileEntry[]): void {
  parseRoleManifest(slug, manifest);
  if (files.length > ROLE_MAX_FILES)
    throw new ValidationError(`a role version holds at most ${ROLE_MAX_FILES} files`, { param: 'files' });
  const coreBytes =
    Buffer.byteLength(manifest, 'utf8') +
    files.filter((file) => file.load === 'core').reduce((sum, file) => sum + file.size_bytes, 0);
  if (coreBytes > ROLE_CORE_MAX_BYTES) {
    throw new ValidationError(
      `manifest plus core files are ${coreBytes} bytes, over the ${ROLE_CORE_MAX_BYTES}-byte activation budget; mark material on_demand`,
      { param: 'files' },
    );
  }
  const binaryCore = files.find((file) => file.load === 'core' && file.encoding !== FILE_ENCODING_UTF8);
  if (binaryCore)
    throw new ValidationError(`core file ${binaryCore.path} must be text; binary material is on_demand`, {
      param: 'files',
    });
  const total = Buffer.byteLength(manifest, 'utf8') + files.reduce((sum, file) => sum + file.size_bytes, 0);
  if (total > ROLE_VERSION_MAX_BYTES)
    throw new ValidationError(`a role version holds at most ${ROLE_VERSION_MAX_BYTES} bytes`, {
      param: 'files',
    });
}

export function fileIndexView(
  role: AgentRole,
  version: Omit<AgentRoleVersion, 'manifest'>,
  files: RoleFileEntry[],
) {
  return files.map((file) => ({
    path: file.path,
    mime_type: file.mime_type,
    load: file.load,
    description: file.description,
    size_bytes: file.size_bytes,
    sha256: file.blob_sha256,
    introduced_in_version: file.introduced_in_version,
    source_proposal_id: file.source_proposal_id,
    uri: roleUri(role.slug, version.version, file.path),
  }));
}

export function versionView(role: AgentRole, version: Omit<AgentRoleVersion, 'manifest'>) {
  return {
    id: version.id,
    version: version.version,
    state: version.state,
    sha256: version.bundleSha256,
    manifest_sha256: version.manifestSha256,
    changelog: version.changelog,
    published_at: version.publishedAt,
    withdrawn_at: version.withdrawnAt,
    source_proposal_id: version.sourceProposalId,
    reverted_from_version: version.revertedFromVersion,
    created_by: version.createdBy,
    published_by: version.publishedBy,
    uri: version.version ? roleUri(role.slug, version.version) : null,
  };
}

/**
 * What an activation (or a reload after compaction) delivers: the manifest, the
 * text of every core file, the index of everything else and the declared tools.
 */
export async function activationPayload(db: RoleDb, role: AgentRole, version: AgentRoleVersion) {
  const files = await versionFiles(db, version.id);
  const manifest = parseRoleManifest(role.slug, version.manifest);
  const core: Array<{ path: string; text: string }> = [];
  for (const file of files.filter((entry) => entry.load === 'core')) {
    const blob = await readBlob(db, file.blob_sha256);
    if (blob && blob.encoding === FILE_ENCODING_UTF8) core.push({ path: file.path, text: blob.content });
  }
  return {
    manifest: version.manifest,
    core_files: core,
    files_index: fileIndexView(
      role,
      version,
      files.filter((entry) => entry.load !== 'core'),
    ),
    tools: manifest.tools,
    collaboration: manifest.collaboration,
  };
}

export async function fileAt(db: RoleDb, versionId: string, path: string) {
  const state = roleState(db);
  if (state)
    return (
      state
        .table('agentRoleVersionFiles')
        .all()
        .find((row) => row.versionId === versionId && row.path === path) ?? null
    );
  const [row] = await db
    .select()
    .from(agentRoleVersionFiles)
    .where(and(eq(agentRoleVersionFiles.versionId, versionId), eq(agentRoleVersionFiles.path, path)))
    .limit(1);
  return row ?? null;
}
