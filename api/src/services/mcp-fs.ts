/**
 * Operator-only filesystem tools. Mirrors the legacy `fs_*` MCP surface
 * (`src/Mcp/McpFileOperations.php`) with strict path confinement.
 *
 * Every path argument is resolved against the configured root via
 * `resolveSafe()`, which rejects paths that escape the root after symlink
 * resolution. The default settings cap read size at 1 MiB, directory
 * listings at 1000 entries, and search hits at 200 — all overridable via
 * env (see `api/src/env.ts`).
 *
 * These tools are registered only when `MCP_FS_ROOT` is set and points at
 * an existing directory (see `api/src/routes/mcp/index.ts`); when unset
 * the registry omits both their definitions and handlers.
 */
import { promises as fsp, type Dirent, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve as resolvePath, relative as relativePath, join as joinPath, sep, basename } from 'node:path';
import { NotFoundError, ValidationError } from '../http/errors.js';

export interface McpFsConfig {
  root: string;
  maxReadBytes: number;
  maxListEntries: number;
  maxSearchHits: number;
}

interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size?: number;
  mtime?: string;
}

interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export class McpFsTools {
  private readonly root: string;
  private readonly maxReadBytes: number;
  private readonly maxListEntries: number;
  private readonly maxSearchHits: number;

  constructor(config: McpFsConfig) {
    if (!config.root || !config.root.trim()) {
      throw new Error('McpFsTools requires a non-empty root');
    }
    this.root = resolvePath(config.root);
    this.maxReadBytes = Math.max(1, Math.floor(config.maxReadBytes));
    this.maxListEntries = Math.max(1, Math.floor(config.maxListEntries));
    this.maxSearchHits = Math.max(1, Math.floor(config.maxSearchHits));
  }

  /**
   * Resolve `userPath` against the configured root and reject if the
   * resolved path escapes. When `requireExists` is true, the path must
   * exist and its realpath must also stay inside the root (symlink-safe).
   */
  async resolveSafe(userPath: unknown, requireExists = false): Promise<string> {
    if (typeof userPath !== 'string' || !userPath.trim()) {
      throw new ValidationError('path is required', { param: 'path' });
    }
    // Drop leading slashes — all paths are root-relative. This also blocks
    // attempts to use absolute paths to escape the sandbox.
    const trimmed = userPath.replace(/^\/+/, '').trim();
    const candidate = trimmed === '' ? this.root : resolvePath(this.root, trimmed);
    if (!isInside(this.root, candidate)) {
      throw new ValidationError('path escapes filesystem root', { param: 'path' });
    }
    if (!requireExists) return candidate;

    // Resolve symlinks and re-check confinement.
    let real: string;
    try {
      real = await fsp.realpath(candidate);
    } catch {
      throw new NotFoundError('path not found');
    }
    if (!isInside(this.root, real)) {
      throw new ValidationError('path escapes filesystem root', { param: 'path' });
    }
    return real;
  }

  /** Convert an absolute path to a root-relative path for output. */
  relPath(abs: string): string {
    const rel = relativePath(this.root, abs);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }

  async readFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const safe = await this.resolveSafe(args['path'], true);
    const stat = await fsp.stat(safe);
    if (!stat.isFile()) {
      throw new ValidationError('path is not a regular file', { param: 'path' });
    }
    const cap = clampInt(args['max_bytes'], this.maxReadBytes, 1, this.maxReadBytes);
    const size = stat.size;
    const toRead = Math.min(size, cap);
    const fh = await fsp.open(safe, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      if (toRead > 0) await fh.read(buf, 0, toRead, 0);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      return {
        path: this.relPath(safe),
        content: buf.toString('utf8'),
        size,
        truncated: toRead < size,
        sha256,
      };
    } finally {
      await fh.close();
    }
  }

  async writeFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const safe = await this.resolveSafe(args['path'], false);
    const content = args['content'];
    if (typeof content !== 'string') {
      throw new ValidationError('content is required', { param: 'content' });
    }
    const modeRaw = args['mode'];
    const mode = typeof modeRaw === 'number' && Number.isFinite(modeRaw) ? modeRaw : 0o644;
    // Resolve the parent dir's symlinks and re-check confinement — a lexical
    // check alone would let a pre-existing symlink under the root redirect
    // the write outside it (see resolveSafe's requireExists path).
    const parent = resolvePath(safe, '..');
    let realParent: string;
    try {
      realParent = await fsp.realpath(parent);
    } catch {
      throw new NotFoundError('parent directory not found');
    }
    if (!isInside(this.root, realParent)) {
      throw new ValidationError('path escapes filesystem root', { param: 'path' });
    }
    const target = joinPath(realParent, basename(safe));
    // If the target itself already exists as a symlink, resolve it too so we
    // don't write through it to somewhere outside the root (including a
    // dangling symlink, which realpath() rejects with ENOENT).
    let writePath = target;
    let existing: Stats | null;
    try {
      existing = await fsp.lstat(target);
    } catch {
      existing = null; // doesn't exist yet — writing a new file is fine
    }
    if (existing?.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = await fsp.realpath(target);
      } catch {
        throw new ValidationError('path escapes filesystem root', { param: 'path' });
      }
      if (!isInside(this.root, realTarget)) {
        throw new ValidationError('path escapes filesystem root', { param: 'path' });
      }
      writePath = realTarget;
    }
    const buf = Buffer.from(content, 'utf8');
    await fsp.writeFile(writePath, buf, { mode });
    return {
      path: this.relPath(writePath),
      bytes_written: buf.length,
    };
  }

  async listDir(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const safe = await this.resolveSafe(args['path'], true);
    const stat = await fsp.stat(safe);
    if (!stat.isDirectory()) {
      throw new ValidationError('path is not a directory', { param: 'path' });
    }
    const recursive = args['recursive'] === true;
    const cap = clampInt(args['max_entries'], this.maxListEntries, 1, this.maxListEntries);
    const entries: DirEntry[] = [];
    if (recursive) {
      await walk(safe, safe, entries, cap);
    } else {
      const names = await fsp.readdir(safe, { withFileTypes: true });
      for (const dirent of names) {
        if (entries.length >= cap) break;
        const full = joinPath(safe, dirent.name);
        entries.push(await describe(dirent.name, full));
      }
    }
    return {
      path: this.relPath(safe),
      entries,
      truncated: entries.length >= cap,
    };
  }

  async fileExists(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const safe = await this.resolveSafe(args['path'], false);
    try {
      const stat = await fsp.lstat(safe);
      const type = entryType(stat);
      return { path: this.relPath(safe), exists: true, type };
    } catch {
      return { path: this.relPath(safe), exists: false };
    }
  }

  async stat(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const safe = await this.resolveSafe(args['path'], true);
    const stat = await fsp.lstat(safe);
    return {
      path: this.relPath(safe),
      type: entryType(stat),
      size: stat.size,
      mode: stat.mode,
      mtime: stat.mtime.toISOString(),
      ctime: stat.ctime.toISOString(),
      uid: stat.uid,
      gid: stat.gid,
    };
  }

  async searchInFiles(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const safe = await this.resolveSafe(args['path'], true);
    const stat = await fsp.stat(safe);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new ValidationError('path is not a regular file or directory', { param: 'path' });
    }
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || pattern === '') {
      throw new ValidationError('pattern is required', { param: 'pattern' });
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError('invalid pattern: ' + msg, { param: 'pattern' });
    }
    const glob = typeof args['glob'] === 'string' && args['glob'] ? (args['glob'] as string) : null;
    const globRe = glob ? compileGlob(glob) : null;
    const cap = clampInt(args['max_hits'], this.maxSearchHits, 1, this.maxSearchHits);

    const matches: SearchMatch[] = [];
    const files: string[] = [];
    if (stat.isFile()) {
      files.push(safe);
    } else {
      await collectFiles(safe, files, 50_000);
    }
    for (const file of files) {
      if (matches.length >= cap) break;
      const rel = this.relPath(file);
      if (globRe && !globRe.test(rel)) continue;
      let text: string;
      try {
        // Cap per-file read to avoid OOM on huge files. Search is best-effort.
        const fstat = await fsp.stat(file);
        if (fstat.size > this.maxReadBytes) continue;
        const buf = await fsp.readFile(file);
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (regex.test(line)) {
          matches.push({ path: rel, line: i + 1, text: truncate(line, 200) });
          if (matches.length >= cap) break;
        }
      }
    }
    return {
      path: this.relPath(safe),
      matches,
      truncated: matches.length >= cap,
    };
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

function entryType(stat: Stats): 'file' | 'dir' | 'symlink' {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  return 'file';
}

async function describe(name: string, full: string): Promise<DirEntry> {
  try {
    const stat = await fsp.lstat(full);
    const entry: DirEntry = { name, type: entryType(stat) };
    if (!stat.isDirectory()) entry.size = stat.size;
    entry.mtime = stat.mtime.toISOString();
    return entry;
  } catch {
    return { name, type: 'file' };
  }
}

async function walk(root: string, current: string, out: DirEntry[], cap: number): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (out.length >= cap) return;
    const full = joinPath(current, dirent.name);
    const rel = relativePath(root, full).split(sep).join('/');
    const stat = await fsp.lstat(full).catch(() => null);
    const type: DirEntry['type'] = stat
      ? entryType(stat)
      : dirent.isDirectory()
      ? 'dir'
      : dirent.isSymbolicLink()
      ? 'symlink'
      : 'file';
    const entry: DirEntry = { name: rel, type };
    if (stat && !stat.isDirectory()) entry.size = stat.size;
    if (stat) entry.mtime = stat.mtime.toISOString();
    out.push(entry);
    if (type === 'dir') {
      await walk(root, full, out, cap);
      if (out.length >= cap) return;
    }
  }
}

async function collectFiles(dir: string, out: string[], maxFiles: number): Promise<void> {
  if (out.length >= maxFiles) return;
  let dirents: Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (out.length >= maxFiles) return;
    const full = joinPath(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue; // skip symlinks during recursive walk
    if (dirent.isDirectory()) {
      await collectFiles(full, out, maxFiles);
    } else if (dirent.isFile()) {
      out.push(full);
    }
  }
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function compileGlob(glob: string): RegExp {
  // Tiny glob → regex: supports *, ?, and literal segments. No brace expansion.
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  return new RegExp('^' + re + '$');
}
