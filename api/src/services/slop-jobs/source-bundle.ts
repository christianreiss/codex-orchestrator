import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { normalizeSlopPath, pathsCollide, SLOP_LIMITS, type SlopFileKind } from './paths.js';

/** Independent transport bound; decoded job and per-file limits stay unchanged. */
export const MAX_SOURCE_BUNDLE_BYTES = 64 * 1024 * 1024;
export type FileUpdate = { path: string; kind: SlopFileKind; sha256: string | null; sizeBytes: number };
export type SourceEntry = FileUpdate & { bytes: Buffer };
type ExistingFile = FileUpdate & { rev: number };

export function parseSourceBundle(bytes: Buffer): SourceEntry[] {
  if (bytes.length > MAX_SOURCE_BUNDLE_BYTES) throw new ValidationError('source bundle is limited to 64 MiB');
  let bundle: unknown;
  try { bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ValidationError('source bundle must be UTF-8 JSON'); }
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new ValidationError('source bundle must be {version: 1, files: [{path, content, sha256?}]}');
  const { version, files } = bundle as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(files) || !files.length || files.length > SLOP_LIMITS.maxJobFiles)
    throw new ValidationError(`source bundle version must be 1 with 1-${SLOP_LIMITS.maxJobFiles} files`);
  const seen = new Set<string>();
  let total = 0;
  return files.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('each source entry must be {path, content, sha256?}');
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !['path', 'content', 'sha256'].includes(key))) throw new ValidationError('source entries allow only path, content and sha256');
    const path = normalizeSlopPath(entry.path);
    if (seen.has(path)) throw new ValidationError(`duplicate source path: ${path}`);
    if ([...seen].some((other) => pathsCollide(other, path))) throw new ValidationError(`source path collision: ${path}`);
    seen.add(path);
    if (typeof entry.content !== 'string') throw new ValidationError(`source content must be text: ${path}`);
    const content = Buffer.from(entry.content, 'utf8');
    if (content.toString('utf8') !== entry.content || content.includes(0)) throw new ValidationError(`source must be valid UTF-8 text without NUL: ${path}`);
    if (content.length > SLOP_LIMITS.maxFileBytes) throw new ValidationError(`source file exceeds ${SLOP_LIMITS.maxFileBytes} bytes: ${path}`);
    total += content.length;
    if (total > SLOP_LIMITS.maxJobBytes) throw new ValidationError('source bundle exceeds the job byte limit');
    const digest = createHash('sha256').update(content).digest('hex');
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.sha256 !== digest))
      throw new ValidationError(`source SHA-256 mismatch or invalid digest: ${path}`);
    return { path, kind: 'source', sha256: digest, sizeBytes: content.length, bytes: content };
  });
}

/** Plan against the locked current state. No revisions are written until all checks pass. */
export function planFileUpdates(rows: ExistingFile[], updates: FileUpdate[]) {
  const latest = new Map<string, ExistingFile>();
  for (const row of rows) if (!latest.has(row.path) || latest.get(row.path)!.rev < row.rev) latest.set(row.path, row);
  const seen = new Set<string>();
  const planned = updates.map((entry) => {
    if (seen.has(entry.path)) throw new ValidationError(`duplicate source path: ${entry.path}`);
    seen.add(entry.path);
    const previous = latest.get(entry.path);
    if (entry.sha256 === null && (!previous || previous.sha256 === null)) throw new NotFoundError(`No current file at ${entry.path}`, 'slop_file_not_found');
    const unchanged = !!previous && previous.sha256 === entry.sha256 && previous.kind === entry.kind;
    const rev = unchanged ? previous.rev : (previous?.rev ?? 0) + 1;
    latest.set(entry.path, { ...entry, rev });
    return { ...entry, rev, unchanged, previous_rev: previous?.sha256 ? previous.rev : null };
  });
  const active = [...latest.values()].filter((file) => file.sha256 !== null);
  if (active.length > SLOP_LIMITS.maxJobFiles || active.reduce((sum, file) => sum + file.sizeBytes, 0) > SLOP_LIMITS.maxJobBytes)
    throw new ConflictError('source import exceeds the job file or byte limit', 'slop_job_full');
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++)
    if (pathsCollide(active[i]!.path, active[j]!.path)) throw new ConflictError(`file/directory collision: ${active[i]!.path} and ${active[j]!.path}`, 'slop_path_collision');
  return planned;
}
