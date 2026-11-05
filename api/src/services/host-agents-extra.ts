/**
 * Optional per-host AGENTS instructions (`hosts.agents_extra`, migration 0126).
 *
 * Operator-authored text appended to the fleet document one host receives —
 * Codex `AGENTS.md`, Claude `CLAUDE.md` and Grok `AGENTS.md` alike. It carries the
 * same trust as the fleet policy (only `hosts.manage` can write it) and sits at
 * the very end, after the managed blocks, under a heading that names the host.
 *
 * The served sha256 is computed over the appended body, so editing the text
 * changes the digest every wrapper compares its on-disk file against and the
 * next sync rewrites the file. No wrapper change is involved.
 */
import { createHash } from 'node:crypto';
import { ValidationError } from '../http/errors.js';

/** UTF-8 bytes after trimming. Fits MySQL TEXT (65,535 bytes) with headroom. */
export const HOST_AGENTS_EXTRA_MAX_BYTES = 32 * 1024;

/**
 * Trimmed text with LF line endings, or null for "none". Rejects anything that
 * is neither a string nor null, NUL bytes, and text over the byte cap.
 */
export function normalizeHostAgentsExtra(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new ValidationError('content must be a string or null', { param: 'content' });
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (text === '') return null;
  if (text.includes('\u0000')) throw new ValidationError('content must not contain NUL bytes', { param: 'content' });
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > HOST_AGENTS_EXTRA_MAX_BYTES)
    throw new ValidationError(
      `content is ${bytes} bytes; the limit is ${HOST_AGENTS_EXTRA_MAX_BYTES} bytes`,
      { param: 'content' },
    );
  return text;
}

export interface HostAgentsExtraSummary {
  content: string | null;
  size_bytes: number;
  sha256: string | null;
  max_bytes: number;
}

export function summarizeHostAgentsExtra(text: string | null | undefined): HostAgentsExtraSummary {
  const content = text ? text : null;
  return {
    content,
    size_bytes: content ? Buffer.byteLength(content, 'utf8') : 0,
    sha256: content ? createHash('sha256').update(content).digest('hex') : null,
    max_bytes: HOST_AGENTS_EXTRA_MAX_BYTES,
  };
}

/**
 * Append the host's instructions to an already rendered document. Without
 * instructions the body is returned untouched, byte for byte.
 */
export function appendHostAgentsExtra(
  body: string,
  host: { fqdn: string; agentsExtra?: string | null },
): { body: string; sha256: string | null } {
  const extra = host.agentsExtra?.trim();
  if (!extra) return { body, sha256: null };
  return {
    body: `${body.replace(/\s+$/, '')}\n\n## Host-specific instructions (${host.fqdn})\n\n${extra}\n`,
    sha256: createHash('sha256').update(extra).digest('hex'),
  };
}
