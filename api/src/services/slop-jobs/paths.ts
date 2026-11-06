import { ValidationError } from '../../http/errors.js';

/** What a job file is used for. `source` is scanned; the others only feed full reviews. */
export const SLOP_FILE_KINDS = ['source', 'screenshot', 'a11y'] as const;
export type SlopFileKind = (typeof SLOP_FILE_KINDS)[number];

/** Limits mirror slop-detector's own scan bounds (2 MB per file) and keep a job small. */
export const SLOP_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxInlineBytes: 256 * 1024,
  maxJobFiles: 200,
  maxJobBytes: 50 * 1024 * 1024,
  maxDescriptionBytes: 64 * 1024,
  maxPathLength: 512,
  idleHours: 24,
  /** A run that has not finished by then is failed by the sweeper. */
  runTimeoutMinutes: 90,
} as const;

const SCREENSHOT = /\.(png|jpe?g|webp)$/i;

/**
 * A project-relative POSIX path. Anything that could escape the run directory
 * or collide with the worker's own files is refused, because slop's scan
 * trusts its root boundary.
 */
export function normalizeSlopPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('path is required');
  const path = raw.trim().replace(/^\.\/+/, '');
  if (!path) throw new ValidationError('path is required');
  if (path.length > SLOP_LIMITS.maxPathLength)
    throw new ValidationError(`path is longer than ${SLOP_LIMITS.maxPathLength} characters`);
  if (path.startsWith('/') || path.includes('\\') || [...path].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f'))
    throw new ValidationError('path must be a relative POSIX path without control characters');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new ValidationError('path must not contain empty, "." or ".." segments');
  if (segments[0] === '.slop' || segments[0] === '.git')
    throw new ValidationError('paths under .slop/ or .git/ are reserved');
  return path;
}

export function inferSlopKind(path: string, requested: unknown): SlopFileKind {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (!SLOP_FILE_KINDS.includes(requested as SlopFileKind))
      throw new ValidationError(`kind must be one of ${SLOP_FILE_KINDS.join(', ')}`);
    const kind = requested as SlopFileKind;
    if (kind === 'screenshot' && !SCREENSHOT.test(path))
      throw new ValidationError('screenshots must be .png, .jpg, .jpeg or .webp files');
    return kind;
  }
  if (SCREENSHOT.test(path)) return 'screenshot';
  return 'source';
}

/** True when one path is a directory prefix of the other (a/b vs a/b/c). */
export function pathsCollide(a: string, b: string): boolean {
  return a !== b && (a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
}

export function isLikelyText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  return !new TextDecoder('utf-8', { fatal: false }).decode(sample).includes('�');
}
