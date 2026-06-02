/**
 * Claude-Code artifact frontmatter: deterministic YAML-lite serialize/parse for
 * the small, known field set used by subagents / slash-commands / output-styles.
 *
 * We deliberately do NOT pull a full YAML library: the canonical `body` (what we
 * hash and ship to hosts) must serialize identically for every fleet member, and
 * the field set is fixed (scalars + a couple of string lists). A purpose-built
 * serializer with a stable key order gives us sha-stable output; the parser
 * handles the common shapes Claude Code itself writes (block lists, inline
 * `[a, b]`, comma strings) and preserves unknown keys verbatim as passthrough so
 * future Claude Code fields aren't silently dropped.
 *
 * The serialized body is the source of truth: `<frontmatter>\n\n<markdown body>`.
 */
import { ValidationError } from '../http/errors.js';

export const ARTIFACT_KINDS = ['subagent', 'command', 'output-style'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Maps an artifact kind to the `~/.claude/<dir>/` it is written into. */
export const KIND_DIRS: Record<ArtifactKind, string> = {
  subagent: 'agents',
  command: 'commands',
  'output-style': 'output-styles',
};

/** Required frontmatter keys per kind — missing ones make the CLI ignore the file. */
const REQUIRED_FIELDS: Record<ArtifactKind, readonly string[]> = {
  subagent: ['name', 'description'],
  command: ['description'],
  'output-style': [],
};

/**
 * Stable serialization order so the same logical artifact always hashes the
 * same. Known keys first (in this order); any remaining keys appended sorted.
 */
const KEY_ORDER: readonly string[] = [
  'name',
  'description',
  'argument-hint',
  'tools',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'permission-mode',
  'color',
  'keep-coding-instructions',
  'disable-model-invocation',
];

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

export function isArtifactKind(x: unknown): x is ArtifactKind {
  return typeof x === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(x);
}

/** Accepts singular or plural / hyphen-or-underscore spellings of a kind. */
export function normalizeKind(raw: unknown): ArtifactKind {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (s) {
    case 'subagent':
    case 'subagents':
    case 'agent':
    case 'agents':
      return 'subagent';
    case 'command':
    case 'commands':
    case 'slash-command':
    case 'slash-commands':
      return 'command';
    case 'output-style':
    case 'output-styles':
    case 'output_style':
    case 'output_styles':
    case 'outputstyle':
      return 'output-style';
    default:
      throw new ValidationError(`unknown artifact kind: ${raw}`, { param: 'kind' });
  }
}

export function normalizeSlug(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('slug is required', { param: 'slug' });
  const slug = raw.trim();
  if (slug === '') throw new ValidationError('slug is required', { param: 'slug' });
  if (slug.length > 255) throw new ValidationError('slug must be 255 characters or fewer', { param: 'slug' });
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    throw new ValidationError('slug cannot include path separators', { param: 'slug' });
  }
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError('slug may only contain letters, numbers, dots, underscores, and hyphens', {
      param: 'slug',
    });
  }
  return slug;
}

function needsQuoting(s: string): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  // Quote when the value could be misread as YAML structure.
  return /[:#[\]{}"'`&*!|>%@,]/.test(s) || /^[-?]/.test(s) || /^(true|false|null|yes|no|~)$/i.test(s);
}

function serializeScalar(v: unknown): string {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v ?? '');
  return needsQuoting(s) ? JSON.stringify(s) : s;
}

function orderedKeys(fm: Record<string, unknown>): string[] {
  const known = KEY_ORDER.filter((k) => k in fm);
  const rest = Object.keys(fm)
    .filter((k) => !KEY_ORDER.includes(k))
    .sort();
  return [...known, ...rest];
}

/** Render a frontmatter object + markdown body into a canonical `.md` string. */
export function serializeFrontmatter(frontmatter: Record<string, unknown>, content: string): string {
  const lines: string[] = ['---'];
  for (const key of orderedKeys(frontmatter)) {
    const v = frontmatter[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const items = v.map((x) => String(x ?? '').trim()).filter((x) => x !== '');
      if (items.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of items) lines.push(`  - ${serializeScalar(item)}`);
      continue;
    }
    if (typeof v === 'string' && v.trim() === '') continue;
    lines.push(`${key}: ${serializeScalar(v)}`);
  }
  lines.push('---');
  const bodyText = (content ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
  return `${lines.join('\n')}\n\n${bodyText}\n`;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t) as string;
      } catch {
        return t.slice(1, -1);
      }
    }
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineList(raw: string): string[] {
  return raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((x) => unquote(x))
    .filter((x) => x !== '');
}

/**
 * Split a `.md` body into a leading frontmatter block + remaining content.
 * Tolerant YAML-lite: scalars, block lists (`key:` then `  - item`), inline
 * lists (`key: [a, b]`), and comma strings for the known list keys.
 */
export function parseFrontmatter(body: string): { frontmatter: Record<string, unknown>; content: string } {
  const text = (body ?? '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, content: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, content: text };
  const block = text.slice(4, end);
  const after = text.slice(end + 4).replace(/^\n/, '');

  const fm: Record<string, unknown> = {};
  const lines = block.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    i++;
    if (line.trim() === '') continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const key = m[1];
    const rest = m[2] ?? '';
    if (rest === '') {
      // Possibly a block list.
      const items: string[] = [];
      let next = lines[i];
      while (next !== undefined && /^\s*-\s+/.test(next)) {
        items.push(unquote(next.replace(/^\s*-\s+/, '')));
        i++;
        next = lines[i];
      }
      fm[key] = items.length > 0 ? items.filter((x) => x !== '') : '';
    } else if (rest.startsWith('[')) {
      fm[key] = parseInlineList(rest);
    } else {
      fm[key] = unquote(rest);
    }
  }
  return { frontmatter: fm, content: after };
}

/** Throws ValidationError listing every required frontmatter key that is missing. */
export function validateForKind(kind: ArtifactKind, frontmatter: Record<string, unknown>): void {
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS[kind]) {
    const v = frontmatter[field];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) missing.push(field);
  }
  if (missing.length > 0) {
    throw new ValidationError(`missing required frontmatter for ${kind}: ${missing.join(', ')}`, {
      extra: { errors: Object.fromEntries(missing.map((f) => [f, [`${f} is required for ${kind}`]])) },
    });
  }
}

/** List frontmatter keys: tools/allowed-tools/disallowed-tools are list-typed. */
export function listKeysForKind(kind: ArtifactKind): readonly string[] {
  if (kind === 'subagent') return ['tools', 'disallowed-tools'];
  if (kind === 'command') return ['allowed-tools'];
  return [];
}
