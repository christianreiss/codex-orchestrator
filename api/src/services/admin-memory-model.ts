import { ConflictError, ValidationError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { isEngine, type Engine } from '../util/engine.js';

export const MEMORY_SCOPES = ['host', 'project', 'shared'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryCapabilities {
  read: true;
  create: boolean;
  update: boolean;
  delete: boolean;
  append: boolean;
}

export interface MemoryDetail {
  node_id: string;
  id: string;
  key: string;
  record_id: number;
  scope: MemoryScope;
  title: string;
  summary: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  tags: string[];
  content_length: number;
  host_id: number | null;
  host: string | null;
  project_id: number | null;
  project_slug: string | null;
  source_host_id: number | null;
  source_host: string | null;
  engine: string | null;
  revision: number | null;
  created_at: string | null;
  updated_at: string | null;
  etag: string;
  capabilities: MemoryCapabilities;
}

export interface UnifiedMemoryRow {
  scope: MemoryScope;
  recordId: number;
  key: string;
  title: string;
  summary: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  tags: string[];
  contentLength: number;
  preview: string;
  ownerHostId: number | null;
  ownerHost: string | null;
  projectId: number | null;
  projectSlug: string | null;
  sourceHostId: number | null;
  sourceHost: string | null;
  engine: string | null;
  revision: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GraphPosition {
  updatedAt: string;
  scope: MemoryScope;
  recordId: number;
}

export interface GraphFilters {
  scopes: MemoryScope[];
  q: string;
  tags: string[];
  hostId: number | null;
  projectSlug: string | null;
  engine: Engine | null;
  limit: number;
  position: GraphPosition | null;
  fingerprint: string;
}

export interface ActivityPosition {
  createdAt: string;
  source: string;
  numericId: number;
}

export interface AuditPayload {
  actor_id: number;
  node_id: string;
  scope: MemoryScope;
  record_id: number;
  memory_id: string;
  old_etag: string | null;
  new_etag: string | null;
  old_content_length: number | null;
  content_length: number | null;
  old_tag_count: number | null;
  tag_count: number | null;
  project_id?: number | null;
  project_slug?: string | null;
  host_id?: number | null;
}

export function memoryNodeId(scope: MemoryScope, recordId: number): string {
  return `memory:${scope}:${recordId}`;
}

export function parseMemoryNodeId(value: string): { scope: MemoryScope; recordId: number } {
  const match = /^memory:(host|project|shared):([1-9]\d*)$/.exec(value.trim());
  if (!match) throw new ValidationError('node_id must be memory:<scope>:<recordId>', { param: 'node_id' });
  return { scope: match[1] as MemoryScope, recordId: Number(match[2]) };
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function memoryEtagForState(state: Record<string, unknown>): string {
  return sha256(JSON.stringify(stableValue(state)));
}

export function etagForRow(row: UnifiedMemoryRow): string {
  return memoryEtagForState({
    scope: row.scope,
    record_id: row.recordId,
    key: row.key,
    title: row.title,
    summary: row.summary,
    content: row.content,
    metadata: row.metadata,
    tags: row.tags,
    host_id: row.ownerHostId,
    project_id: row.projectId,
    source_host_id: row.sourceHostId,
    engine: row.engine,
    revision: row.revision,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

export function memoryCapabilities(scope: MemoryScope, canMutate: boolean): MemoryCapabilities {
  return {
    read: true,
    create: canMutate,
    update: canMutate,
    delete: canMutate,
    append: canMutate && scope === 'shared',
  };
}

export function toMemoryDetail(row: UnifiedMemoryRow, canMutate: boolean): MemoryDetail {
  return {
    node_id: memoryNodeId(row.scope, row.recordId),
    id: row.key,
    key: row.key,
    record_id: row.recordId,
    scope: row.scope,
    title: row.title,
    summary: row.summary,
    content: row.content,
    metadata: row.metadata,
    tags: row.tags,
    content_length: row.contentLength,
    host_id: row.ownerHostId,
    host: row.ownerHost,
    project_id: row.projectId,
    project_slug: row.projectSlug,
    source_host_id: row.sourceHostId,
    source_host: row.sourceHost,
    engine: row.engine,
    revision: row.revision,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    etag: etagForRow(row),
    capabilities: memoryCapabilities(row.scope, canMutate),
  };
}

export function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function normalizeList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    const normalized = trimmed.toLowerCase();
    if (!trimmed || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(trimmed);
  }
  return out;
}

export function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) && typeof value !== 'string') {
    throw new ValidationError('tags must be an array of strings', { param: 'tags' });
  }
  const out = normalizeList(value);
  if (out.length > 32) throw new ValidationError('no more than 32 tags allowed', { param: 'tags' });
  const tooLong = out.find((tag) => tag.length > 64);
  if (tooLong) throw new ValidationError(`tag "${tooLong}" is longer than 64 characters`, { param: 'tags' });
  return out;
}

export function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('metadata must be an object or null', { param: 'metadata' });
  }
  return value as Record<string, unknown>;
}

export function normalizePositiveInt(value: unknown, param: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ValidationError(`${param} must be a positive integer`, { param });
  }
  return parsed;
}

export function normalizeMemoryKey(value: unknown, scope: 'host' | 'project'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('id is required', { param: 'id' });
  }
  const key = value.trim();
  if (key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ValidationError(
      'id may contain at most 128 letters, numbers, dots, underscores, hyphens, and colons',
      { param: 'id' },
    );
  }
  if (scope === 'host' && /^coco(?:$|[._:-])/i.test(key)) {
    throw new ValidationError('ids beginning with coco are reserved for shared project coordination', {
      param: 'id',
    });
  }
  return key;
}

export function normalizeSharedSlug(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('id is required', { param: 'id' });
  }
  const slug = value.trim().toLowerCase();
  if (slug.length > 160 || !/^[a-z0-9][a-z0-9._:-]*$/.test(slug)) {
    throw new ValidationError('id must be a valid lowercase shared-memory slug', { param: 'id' });
  }
  return slug;
}

export function normalizeContent(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('content is required', { param: 'content' });
  }
  const content = value.trim();
  if (content.length > max) {
    throw new ValidationError(`content must be ${max} characters or fewer`, { param: 'content' });
  }
  return content;
}

export function normalizeNullableText(value: unknown, param: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${param} must be a string or null`, { param });
  const text = value.trim();
  if (text.length > max) throw new ValidationError(`${param} must be ${max} characters or fewer`, { param });
  return text || null;
}

export function normalizeEngine(value: unknown): Engine | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isEngine(value))
    throw new ValidationError('engine must be codex, claude, or null', { param: 'engine' });
  return value;
}

export function assertEtag(expected: unknown, row: UnifiedMemoryRow): void {
  if (typeof expected !== 'string' || expected.trim() === '') {
    throw new ValidationError('expected_etag is required', { param: 'expected_etag' });
  }
  const wanted = expected.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const current = etagForRow(row);
  if (wanted !== current) {
    throw new ConflictError('Memory changed since it was read; reload before saving', 'memory_conflict', {
      current_etag: current,
      node_id: memoryNodeId(row.scope, row.recordId),
    });
  }
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

export function readInsertId(result: unknown): number | null {
  if (!Array.isArray(result) || !result[0] || typeof result[0] !== 'object') return null;
  const value = (result[0] as { insertId?: unknown }).insertId;
  return typeof value === 'number' && value > 0 ? value : null;
}

export function isDuplicateError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const item = current as { errno?: unknown; code?: unknown; cause?: unknown };
    if (item.errno === 1062 || item.code === 'ER_DUP_ENTRY') return true;
    current = item.cause;
  }
  return false;
}

function encodeOpaque(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeOpaque(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError('cursor is invalid for these filters', { param: 'cursor' });
  }
}

/** Retained for callers/tests that used the original offset-cursor helper. */
export function decodeMemoryGraphCursor(value: string, fingerprint: string): number {
  const parsed = decodeOpaque(value);
  if (
    parsed['v'] !== 1 ||
    parsed['fingerprint'] !== fingerprint ||
    !Number.isSafeInteger(parsed['offset']) ||
    Number(parsed['offset']) < 0
  ) {
    throw new ValidationError('cursor is invalid for these filters', { param: 'cursor' });
  }
  return Number(parsed['offset']);
}

export function encodeGraphPosition(position: GraphPosition, fingerprint: string): string {
  return encodeOpaque({ v: 2, fingerprint, ...position });
}

export function decodeGraphPosition(value: string, fingerprint: string): GraphPosition {
  const parsed = decodeOpaque(value);
  if (
    parsed['v'] !== 2 ||
    parsed['fingerprint'] !== fingerprint ||
    typeof parsed['updatedAt'] !== 'string' ||
    !(MEMORY_SCOPES as readonly unknown[]).includes(parsed['scope']) ||
    !Number.isSafeInteger(parsed['recordId']) ||
    Number(parsed['recordId']) < 1
  ) {
    throw new ValidationError('cursor is invalid for these filters', { param: 'cursor' });
  }
  return {
    updatedAt: parsed['updatedAt'],
    scope: parsed['scope'] as MemoryScope,
    recordId: Number(parsed['recordId']),
  };
}

export function encodeActivityPosition(position: ActivityPosition, fingerprint: string): string {
  return encodeOpaque({ v: 1, fingerprint, ...position });
}

export function decodeActivityPosition(value: string, fingerprint: string): ActivityPosition {
  const parsed = decodeOpaque(value);
  if (
    parsed['v'] !== 1 ||
    parsed['fingerprint'] !== fingerprint ||
    typeof parsed['createdAt'] !== 'string' ||
    typeof parsed['source'] !== 'string' ||
    !Number.isSafeInteger(parsed['numericId']) ||
    Number(parsed['numericId']) < 1
  ) {
    throw new ValidationError('cursor is invalid for these filters', { param: 'cursor' });
  }
  return { createdAt: parsed['createdAt'], source: parsed['source'], numericId: Number(parsed['numericId']) };
}

export function sanitizeMemoryAuditDetails(value: unknown): Record<string, unknown> | null {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const isBodyBearingKey = (key: string): boolean => {
    const normalized = key.toLowerCase();
    if (/(?:^|_)(?:length|count|sha|sha256|digest|etag)(?:$|_)/.test(normalized)) return false;
    return (
      normalized === 'body' ||
      normalized === 'content' ||
      normalized === 'preview' ||
      normalized === 'metadata' ||
      /(?:^|_)(?:body|content|preview|metadata)$/.test(normalized)
    );
  };
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .filter(([key]) => !isBodyBearingKey(key))
        .map(([key, child]) => [key, clean(child)]),
    );
  };
  return clean(raw) as Record<string, unknown>;
}
