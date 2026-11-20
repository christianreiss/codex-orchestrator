/**
 * One write validator for the host-scoped memory store (`memory_*`,
 * mcp-memories.ts), the project-scoped store (`project_memory_*`,
 * host-projects.ts) and the admin console writing either scope
 * (admin-memory-model.ts). Until 2026-11-20 each had its own copy and they
 * disagreed (API-KNOW-07): the project store coerced a numeric key or
 * content to a string, host memory coerced content, and the admin console
 * took a comma-separated tag string, dropped non-string tags silently and
 * checked the tag count before tag length.
 *
 * Each rule returns the normalized value and its problems in check order, so
 * the same input gets the same verdict everywhere. Callers keep their own
 * error envelope: MCP stores report `extra.errors` by field, the admin
 * console the first problem with `param`.
 *
 * The CoCo reservation is the one intentional difference, and it is by scope,
 * not by caller: host scope refuses `coco…` keys to steer agents to project
 * memory, which is exactly where those keys belong.
 */
export const MEMORY_MAX_CONTENT = 32_000;
export const MEMORY_MAX_KEY_LENGTH = 128;
export const MEMORY_MAX_TAGS = 32;
export const MEMORY_MAX_TAG_LENGTH = 64;

const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const RESERVED_COCO = /^coco(?:$|[._:-])/i;

export type MemoryKeyScope = 'host' | 'project';

export interface Checked<T> {
  value: T;
  problems: string[];
}

/**
 * `field` is the name the caller's API uses (`id` or `key`). With `optional`,
 * a missing or blank key is `null` without a problem (memory_store then
 * generates one).
 */
export function checkMemoryKey(value: unknown, field: string, scope: MemoryKeyScope, optional = false): Checked<string | null> {
  const missing = { value: null, problems: optional ? [] : [`${field} is required`] };
  if (value === null || value === undefined) return missing;
  if (typeof value !== 'string') return { value: null, problems: [`${field} must be a string`] };
  const key = value.trim();
  if (!key) return missing;
  const problems: string[] = [];
  if (key.length > MEMORY_MAX_KEY_LENGTH) problems.push(`${field} must be ${MEMORY_MAX_KEY_LENGTH} characters or fewer`);
  if (!KEY_PATTERN.test(key)) problems.push(`${field} may only contain letters, numbers, dots, underscores, hyphens, and colons`);
  if (scope === 'host' && RESERVED_COCO.test(key)) {
    problems.push(
      'ids beginning with coco are reserved for CoCo shared handoffs; use shared projects (`/projects` or `project_*`) instead of host-scoped MCP memory',
    );
  }
  return { value: key, problems };
}

/** Trimmed, non-empty text of at most `max` characters. */
export function checkMemoryContent(value: unknown, max: number = MEMORY_MAX_CONTENT): Checked<string> {
  if (value !== null && value !== undefined && typeof value !== 'string') {
    return { value: '', problems: ['content must be a string'] };
  }
  const content = (value ?? '').trim();
  if (!content) return { value: '', problems: ['content is required'] };
  if (content.length > max) return { value: content, problems: [`content must be ${max} characters or fewer`] };
  return { value: content, problems: [] };
}

/**
 * An array of strings: trimmed, blanks dropped, de-duplicated
 * case-insensitively keeping the first spelling. Invalid entries are reported
 * and skipped; the count limit applies to what remains.
 */
export function checkMemoryTags(value: unknown): Checked<string[]> {
  if (value === null || value === undefined) return { value: [], problems: [] };
  if (!Array.isArray(value)) return { value: [], problems: ['tags must be an array of strings'] };
  const problems: string[] = [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== 'string') {
      problems.push('tags must be strings');
      continue;
    }
    const trimmed = tag.trim();
    if (!trimmed) continue;
    if (trimmed.length > MEMORY_MAX_TAG_LENGTH) {
      problems.push(`tag "${trimmed}" is longer than ${MEMORY_MAX_TAG_LENGTH} characters`);
      continue;
    }
    const folded = trimmed.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(trimmed);
  }
  if (out.length > MEMORY_MAX_TAGS) problems.push(`no more than ${MEMORY_MAX_TAGS} tags allowed`);
  return { value: out, problems };
}

/** A JSON object, or null when absent. */
export function checkMemoryMetadata(value: unknown): Checked<Record<string, unknown> | null> {
  if (value === null || value === undefined) return { value: null, problems: [] };
  if (typeof value !== 'object' || Array.isArray(value)) return { value: null, problems: ['metadata must be an object'] };
  return { value: value as Record<string, unknown>, problems: [] };
}
