import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { parseFrontmatter } from './claude-frontmatter.js';

/**
 * Shared provenance helpers for rows in `skills`.
 *
 * A non-blank `source_type` is the ownership marker: those rows are refreshed
 * by their source adapter and are read-only through the ordinary admin/host
 * mutation surfaces. The remaining fields are attribution, not ownership
 * switches, so a partially populated row cannot accidentally become editable.
 */

export interface SkillProvenanceRow {
  sourceType?: string | null;
  sourceRepository?: string | null;
  sourcePath?: string | null;
  sourceRevision?: string | null;
  sourceLicense?: string | null;
  bundleSha256?: string | null;
}

export interface SkillProvenanceView {
  source_type: string | null;
  source_repository: string | null;
  source_path: string | null;
  source_revision: string | null;
  source_license: string | null;
  bundle_sha256: string | null;
}

export interface StoredSkillBundleRow extends SkillProvenanceRow {
  manifest: string;
  sha256: string;
}

export interface StoredSkillBundleFile {
  path: string;
  sha256: string;
  content: string;
}

export interface SkillBundleIntegrity {
  valid: boolean;
  reason: string | null;
  manifestSha256: string;
  bundleSha256: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Matches Go's string ordering: raw UTF-8 bytes, independent of host locale. */
export function compareUtf8Bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Canonical digest shared by import-time construction and read-time checks. */
export function computeSkillBundleDigest(files: Array<{ path: string; sha256: string }>): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => compareUtf8Bytewise(a.path, b.path))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256.toLowerCase());
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Verify the complete stored representation before exposing a source-owned
 * bundle. This catches partial/manual DB edits and prevents a stale advertised
 * bundle digest from blessing content that no longer matches it.
 */
export function inspectStoredSkillBundle(
  row: StoredSkillBundleRow,
  files: StoredSkillBundleFile[],
): SkillBundleIntegrity {
  const manifestSha256 = sha256(row.manifest);
  const storedManifestSha = row.sha256.trim().toLowerCase();
  const storedBundleSha = row.bundleSha256?.trim().toLowerCase() ?? '';
  const fail = (reason: string, bundleSha256 = ''): SkillBundleIntegrity => ({
    valid: false,
    reason,
    manifestSha256,
    bundleSha256,
  });

  if (!SHA256_RE.test(storedManifestSha) || storedManifestSha !== manifestSha256) {
    return fail('manifest sha256 mismatch');
  }
  if (!SHA256_RE.test(storedBundleSha)) return fail('bundle sha256 is missing or invalid');

  const seen = new Set<string>(['skill.md']);
  const digestFiles: Array<{ path: string; sha256: string }> = [
    { path: 'SKILL.md', sha256: manifestSha256 },
  ];
  for (const file of files) {
    const fileSha = file.sha256.trim().toLowerCase();
    const collisionKey = file.path.toLocaleLowerCase('en-US');
    if (file.path === '' || file.path === 'SKILL.md' || seen.has(collisionKey)) {
      return fail(`duplicate or reserved file path: ${file.path}`);
    }
    seen.add(collisionKey);
    if (!SHA256_RE.test(fileSha) || sha256(file.content) !== fileSha) {
      return fail(`file sha256 mismatch: ${file.path}`);
    }
    digestFiles.push({ path: file.path, sha256: fileSha });
  }

  const bundleSha256 = computeSkillBundleDigest(digestFiles);
  if (bundleSha256 !== storedBundleSha) return fail('bundle sha256 mismatch', bundleSha256);
  return { valid: true, reason: null, manifestSha256, bundleSha256 };
}

export function isSourceOwnedSkill(row: SkillProvenanceRow): boolean {
  return typeof row.sourceType === 'string' && row.sourceType.trim() !== '';
}

export function skillProvenanceView(row: SkillProvenanceRow): SkillProvenanceView {
  return {
    source_type: row.sourceType ?? null,
    source_repository: row.sourceRepository ?? null,
    source_path: row.sourcePath ?? null,
    source_revision: row.sourceRevision ?? null,
    source_license: row.sourceLicense ?? null,
    bundle_sha256: row.bundleSha256 ?? null,
  };
}

/** Prefer a complete-bundle digest only when it is a valid SHA-256 value. */
export function effectiveSkillDigest(row: SkillProvenanceRow, fallback: string): string {
  const bundle = row.bundleSha256?.trim().toLowerCase() ?? '';
  return /^[a-f0-9]{64}$/.test(bundle) ? bundle : fallback;
}

/**
 * Anthropic's `disable-model-invocation` marks a skill as explicit-only. The
 * same manifest is served to both engines, so surface that semantic rather than
 * making every consumer re-parse YAML-lite frontmatter independently.
 */
export function allowsImplicitSkillInvocation(manifest: string): boolean {
  const raw = parseFrontmatter(manifest).frontmatter['disable-model-invocation'];
  const disabled = raw === true
    || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true');
  return !disabled;
}
