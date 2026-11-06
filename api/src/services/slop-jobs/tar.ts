/**
 * Minimal POSIX ustar writer for the full-review bundle the Fleet Advisor
 * fetches as one transfer. Entries are regular files with already validated,
 * relative paths (`normalizeSlopPath`); names over 100 bytes use the ustar
 * prefix field (paths are capped at 512 characters, so long names fall back
 * to a hashed name recorded in the bundle manifest).
 */
import { createHash } from 'node:crypto';

export interface TarEntry {
  name: string;
  data: Buffer;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function splitName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i),
      rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, name: rest };
  }
  return null;
}

/** The archive name used for a path; long paths get a stable hashed name. */
export function tarName(path: string): string {
  if (splitName(path)) return path;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? '';
  return `long/${createHash('sha256').update(path).digest('hex').slice(0, 32)}${ext}`;
}

function header(entry: TarEntry, mtime: number): Buffer {
  const parts = splitName(entry.name);
  if (!parts) throw new Error(`tar name too long: ${entry.name}`);
  const block = Buffer.alloc(512, 0);
  block.write(parts.name, 0, 100, 'utf8');
  block.write(octal(0o644, 8), 100, 8, 'ascii');
  block.write(octal(10001, 8), 108, 8, 'ascii');
  block.write(octal(10001, 8), 116, 8, 'ascii');
  block.write(octal(entry.data.length, 12), 124, 12, 'ascii');
  block.write(octal(mtime, 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(parts.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

export function buildTar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(header(entry, mtime), entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}
