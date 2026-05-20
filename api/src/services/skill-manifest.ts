/**
 * Parse + validate skill manifests. The legacy PHP allows manifests as raw
 * markdown/text, so we treat the body as opaque text and only validate the
 * slug + sha + size constraints. JSON manifests are also supported: when
 * the body parses as JSON we surface the parsed object back to callers so
 * the admin UI can render structured previews.
 */
import { ValidationError } from '../http/errors.js';

const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const DRAFT_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface ParsedManifest {
  slug: string;
  body: string;
  parsedJson: unknown;
}

export function normalizeSlug(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('slug is required', { param: 'slug' });
  const slug = raw.trim();
  if (slug === '') throw new ValidationError('slug is required', { param: 'slug' });
  if (slug.length > 255) {
    throw new ValidationError('slug must be 255 characters or fewer', { param: 'slug' });
  }
  if (slug.includes('..') || slug.includes('/')) {
    throw new ValidationError('slug cannot include path separators', { param: 'slug' });
  }
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError(
      'slug may only contain letters, numbers, dots, underscores, and hyphens',
      { param: 'slug' },
    );
  }
  return slug;
}

export function parseManifest(slug: string, manifestBody: unknown): ParsedManifest {
  const normalizedSlug = normalizeSlug(slug);
  if (typeof manifestBody !== 'string' || manifestBody.trim() === '') {
    throw new ValidationError('manifest is required', { param: 'manifest' });
  }
  const body = manifestBody;
  let parsedJson: unknown = null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      parsedJson = null;
    }
  }
  return { slug: normalizedSlug, body, parsedJson };
}

export function canonicalSkillUri(slug: string): string {
  return `skill://${encodeURIComponent(slug)}`;
}

export interface SkillDraft {
  slug: string;
  display_name: string;
  description: string;
  tags: string[];
  what: string;
  when: string;
  steps: string;
}

export function normalizeDraftSlug(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ValidationError('slug is required', { param: 'slug' });
  }
  const slug = raw.trim();
  if (slug === '') throw new ValidationError('slug is required', { param: 'slug' });
  if (slug.length > 255) {
    throw new ValidationError('slug must be 255 characters or fewer', { param: 'slug' });
  }
  if (!DRAFT_SLUG_RE.test(slug)) {
    throw new ValidationError(
      'slug must start with a lowercase letter or number and contain only lowercase letters, numbers, dot, underscore, or dash',
      { param: 'slug' },
    );
  }
  return slug;
}

function normalizeDraftLine(value: unknown, field: string, required: boolean): string {
  if (typeof value !== 'string') {
    if (required) throw new ValidationError(`${field} is required`, { param: field });
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '' && required) {
    throw new ValidationError(`${field} is required`, { param: field });
  }
  return normalized;
}

function normalizeDraftSection(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} is required`, { param: field });
  }
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized === '') {
    throw new ValidationError(`${field} is required`, { param: field });
  }
  return normalized;
}

function normalizeDraftTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError('tags must be an array', { param: 'tags' });
  }
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string') continue;
    const normalized = tag.replace(/\s+/g, ' ').trim();
    if (normalized === '') continue;
    if (!tags.includes(normalized)) tags.push(normalized);
  }
  return tags;
}

export function normalizeSkillDraft(draft: Record<string, unknown>): SkillDraft {
  const slug = normalizeDraftSlug(draft.slug);
  const display_name = normalizeDraftLine(draft.display_name, 'display_name', true);
  const description = normalizeDraftLine(draft.description, 'description', true);
  const tags = normalizeDraftTags(draft.tags ?? []);
  const what = normalizeDraftSection(draft.what, 'what');
  const whenSection = normalizeDraftSection(draft.when, 'when');
  const steps = normalizeDraftSection(draft.steps, 'steps');
  return { slug, display_name, description, tags, what, when: whenSection, steps };
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildSkillManifest(fields: SkillDraft): string {
  const displayName = fields.display_name.trim();
  const description = fields.description.trim();
  const tags = Array.isArray(fields.tags) ? fields.tags : [];
  const what = fields.what.replace(/\r\n/g, '\n').trim();
  const whenSection = fields.when.replace(/\r\n/g, '\n').trim();
  const steps = fields.steps.replace(/\r\n/g, '\n').trim();

  const lines: string[] = ['---'];
  if (displayName !== '') lines.push(`name: ${quoteYaml(displayName)}`);
  if (description !== '') lines.push(`description: ${quoteYaml(description)}`);
  if (tags.length > 0) {
    lines.push('tags:');
    for (const tag of tags) lines.push(`  - ${quoteYaml(tag)}`);
  }
  lines.push('---', '', '# What this skill does', '', what, '', '## When to use this skill', '', whenSection, '', '## Step-by-Step Instructions', '', steps);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
