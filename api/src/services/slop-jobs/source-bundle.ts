import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';
import { inferSlopKind, isLikelyText, normalizeSlopPath, pathsCollide, SLOP_LIMITS, type SlopFileKind } from './paths.js';

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
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new ValidationError('source bundle must be {version: 1, files: [{path, content | content_base64, sha256?, kind?}]}');
  const { version, files } = bundle as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(files) || !files.length || files.length > SLOP_LIMITS.maxJobFiles)
    throw new ValidationError(`source bundle version must be 1 with 1-${SLOP_LIMITS.maxJobFiles} files`);
  const seen = new Set<string>();
  let total = 0;
  return files.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('each bundle entry must be {path, content | content_base64, sha256?, kind?}');
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !['path', 'content', 'content_base64', 'sha256', 'kind'].includes(key)))
      throw new ValidationError('bundle entries allow only path, content, content_base64, sha256 and kind');
    const path = normalizeSlopPath(entry.path);
    if (seen.has(path)) throw new ValidationError(`duplicate source path: ${path}`);
    if ([...seen].some((other) => pathsCollide(other, path))) throw new ValidationError(`source path collision: ${path}`);
    seen.add(path);
    if ((entry.content === undefined) === (entry.content_base64 === undefined))
      throw new ValidationError(`pass exactly one of content or content_base64: ${path}`);
    let content: Buffer, kind: SlopFileKind;
    if (entry.content_base64 === undefined) {
      // Text entries stay `source` unless the caller says `a11y`; binary screenshots need content_base64.
      if (typeof entry.content !== 'string') throw new ValidationError(`source content must be text: ${path}`);
      content = Buffer.from(entry.content, 'utf8');
      if (content.toString('utf8') !== entry.content || content.includes(0)) throw new ValidationError(`source must be valid UTF-8 text without NUL: ${path}`);
      kind = entry.kind === undefined ? 'source' : inferSlopKind(path, entry.kind);
      if (kind === 'screenshot') throw new ValidationError(`screenshots must be sent as content_base64: ${path}`);
    } else {
      const encoded = entry.content_base64;
      if (typeof encoded !== 'string' || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
        throw new ValidationError(`content_base64 must be canonical base64: ${path}`);
      content = Buffer.from(encoded, 'base64');
      if (content.toString('base64') !== encoded) throw new ValidationError(`content_base64 must be canonical base64: ${path}`);
      kind = inferSlopKind(path, entry.kind);
      if (kind !== 'screenshot' && !isLikelyText(content)) throw new ValidationError(`${path} is not UTF-8 text; only screenshots may be binary`);
    }
    if (content.length > SLOP_LIMITS.maxFileBytes) throw new ValidationError(`file exceeds ${SLOP_LIMITS.maxFileBytes} bytes: ${path}`);
    if (kind === 'a11y') {
      try { JSON.parse(content.toString('utf8')); }
      catch { throw new ValidationError(`a11y files must be JSON exports ({tool, findings[]}): ${path}`); }
    }
    total += content.length;
    if (total > SLOP_LIMITS.maxJobBytes) throw new ValidationError('bundle exceeds the job byte limit');
    const digest = createHash('sha256').update(content).digest('hex');
    if (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.sha256 !== digest))
      throw new ValidationError(`SHA-256 mismatch or invalid digest: ${path}`);
    return { path, kind, sha256: digest, sizeBytes: content.length, bytes: content };
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
