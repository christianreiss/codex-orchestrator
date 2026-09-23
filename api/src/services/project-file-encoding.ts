/**
 * What a project file's body is, how big it is, and what it claims to be.
 *
 * Shared by the two services that write project files — `host-projects.ts` for
 * hosts and MCP, `project-content.ts` for the admin console — because a limit
 * one of them enforces and the other does not is not a limit.
 */
import { createHash } from 'node:crypto';

export const FILE_ENCODING_UTF8 = 'utf8';
export const FILE_ENCODING_BASE64 = 'base64';
export type ProjectFileEncoding = typeof FILE_ENCODING_UTF8 | typeof FILE_ENCODING_BASE64;

/**
 * 4 MiB of decoded bytes. Project files had no limit at all — not in either
 * normalizer, not in either service — so the only ceiling was Fastify's 32 MiB
 * body limit and whatever `max_allowed_packet` allowed. That is out of step with
 * everything around it: `roster_markdown` caps at 65535 and a project memory at
 * 32000, and both of those hold far less than a file is asked to.
 *
 * The number is chosen to fit what a migration project actually attaches — a
 * config tarball, a PDF, a screenshot, an inventory CSV — while staying well
 * under the body limit once base64 has added its third.
 */
export const FILE_MAX_DECODED_BYTES = 4 * 1024 * 1024;

/** `coord_project_files.stored_name` is VARCHAR(255) and nothing checked. */
export const STORED_NAME_MAX = 255;

/**
 * A rejection, reported rather than thrown.
 *
 * The two services that write project files disagree about error shape —
 * `host-projects.ts` throws `ValidationError('Validation failed', {extra:
 * {errors: {field: [msg]}}})` and `project-content.ts` throws
 * `ValidationError(msg, {param: field})`. Both shapes are load-bearing for their
 * own callers, so this module reports the field and the message and lets each
 * service raise it its own way.
 */
export interface FileBodyRejection {
  field: 'content' | 'encoding' | 'stored_name';
  message: string;
}

export interface FileBodyAccepted {
  /** The body as it should be stored — base64 canonicalized, text untouched. */
  body: string;
  encoding: ProjectFileEncoding;
  sizeBytes: number;
  sha256: string;
}

export function normalizeFileEncoding(value: unknown): ProjectFileEncoding | null {
  if (value === undefined || value === null || value === '') return FILE_ENCODING_UTF8;
  const text = String(value).trim().toLowerCase();
  if (text === 'utf8' || text === 'utf-8' || text === 'text') return FILE_ENCODING_UTF8;
  if (text === 'base64' || text === 'b64') return FILE_ENCODING_BASE64;
  return null;
}

/**
 * The single gate every project-file body passes through, whichever service is
 * writing it: decide the encoding, reject a malformed or oversized body, and
 * return the stored form together with the size and digest that describe the
 * bytes it represents.
 */
export function acceptFileBody(
  content: string,
  encodingRaw: unknown,
): { ok: true; value: FileBodyAccepted } | { ok: false; error: FileBodyRejection } {
  const encoding = normalizeFileEncoding(encodingRaw);
  if (encoding === null) {
    return { ok: false, error: { field: 'encoding', message: "encoding must be 'utf8' or 'base64'" } };
  }

  let body = content;
  if (encoding === FILE_ENCODING_BASE64) {
    if (!isWellFormedBase64(body)) {
      return { ok: false, error: { field: 'content', message: 'content is not valid base64' } };
    }
    body = canonicalizeBase64(body);
  }

  const sizeBytes = decodedByteLength(body, encoding);
  if (sizeBytes > FILE_MAX_DECODED_BYTES) {
    return {
      ok: false,
      error: {
        field: 'content',
        message:
          `content is ${sizeBytes} bytes, over the ${FILE_MAX_DECODED_BYTES}-byte limit for a ` +
          'project file. Split it, store a summary, or move the bytes through transfer_put.',
      },
    };
  }

  return { ok: true, value: { body, encoding, sizeBytes, sha256: contentDigest(body, encoding) } };
}

export function storedNameTooLong(name: string): boolean {
  return name.length > STORED_NAME_MAX;
}

export const STORED_NAME_TOO_LONG_MESSAGE =
  `stored_name must be ${STORED_NAME_MAX} characters or fewer`;

/**
 * The decoded length of a base64 body, without decoding it. Every 4 characters
 * carry 3 bytes, less one per '=' of padding. Worth not decoding: this runs on
 * every read of every file in a listing.
 */
export function base64DecodedLength(body: string): number {
  const compact = body.replace(/\s+/g, '');
  if (compact.length === 0) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

/**
 * The size a file reports. For a text body that is its UTF-8 length; for an
 * encoded one it is the size of what it encodes, because a caller who stored a
 * 3 MiB PDF wants to be told 3 MiB, not the 4 MiB envelope it travelled in.
 */
export function decodedByteLength(content: string, encoding: string | null | undefined): number {
  return encoding === FILE_ENCODING_BASE64
    ? base64DecodedLength(content)
    : Buffer.byteLength(content, 'utf8');
}

/**
 * The digest a file reports, over the same bytes `decodedByteLength` counts. A
 * sha256 of base64 text cannot be compared against a sha256 taken of the file
 * anywhere else, which makes it useless for the one thing a digest is for.
 */
export function contentDigest(content: string, encoding: ProjectFileEncoding): string {
  const bytes = encoding === FILE_ENCODING_BASE64
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reject a body that is not the encoding it says it is, before it is stored.
 * Node's base64 decoder silently drops anything it does not recognise, so
 * without this check a typo becomes a shorter file rather than an error.
 */
export function isWellFormedBase64(content: string): boolean {
  const compact = content.replace(/\s+/g, '');
  return /^[A-Za-z0-9+/]*={0,2}$/.test(compact) && compact.length % 4 === 0;
}

/**
 * The form a base64 body is stored in: whitespace stripped.
 *
 * Not cosmetic. It makes `octet_length(content)` in SQL exactly four thirds of
 * the decoded size, which is what lets a file listing report byte-accurate sizes
 * without pulling the LONGTEXT out of the database. A body wrapped at 76 columns
 * would make that arithmetic wrong by the number of newlines.
 */
export function canonicalizeBase64(content: string): string {
  return content.replace(/\s+/g, '');
}

/**
 * `size_bytes` computed from what SQL can cheaply report — the stored body's
 * length and its last two characters — rather than from the body itself.
 * Mirrors `decodedByteLength`, and `project-file-encoding.test.ts` holds the two
 * against each other so they cannot drift.
 */
export function decodedLengthFromStored(
  storedBytes: number,
  tail: string,
  encoding: string | null | undefined,
): number {
  if (encoding !== FILE_ENCODING_BASE64) return storedBytes;
  const padding = tail.endsWith('==') ? 2 : tail.endsWith('=') ? 1 : 0;
  return Math.floor((storedBytes * 3) / 4) - padding;
}

/**
 * A mime type guessed from the stored name, used only when the caller gave
 * none. 30 of 49 files on one live project had a NULL mime type, which is what
 * happens when nothing infers and every caller has to remember.
 *
 * Deliberately short: this exists so a `.md` file says `text/markdown`, not so
 * the orchestrator becomes a mime database. An unrecognised extension stays
 * NULL, which is honest.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  sql: 'application/sql',
  conf: 'text/plain',
  ini: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  pcap: 'application/vnd.tcpdump.pcap',
};

export function inferMimeType(storedName: string): string | null {
  const base = storedName.slice(storedName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return MIME_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? null;
}

