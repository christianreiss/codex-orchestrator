/**
 * Parse + validate skill manifests. The legacy PHP allows manifests as raw
 * markdown/text, so we treat the body as opaque text and only validate the
 * slug + sha + size constraints. JSON manifests are also supported: when
 * the body parses as JSON we surface the parsed object back to callers so
 * the admin UI can render structured previews.
 */
import { ValidationError } from '../http/errors.js';

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

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
