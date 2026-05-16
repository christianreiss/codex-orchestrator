import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { tokenUsages, tokenUsageIngests } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE, parseEngine } from '../util/engine.js';

/**
 * Port of TokenUsageTracker. Accepts a wrapper-friendly payload (single entry
 * with `line` and/or numeric fields, OR a `usages: [...]` array of entries)
 * and writes per-entry rows in `token_usages` and an ingest summary in
 * `token_usage_ingests`.
 *
 * Validation rules carried over:
 *   - every entry needs `line` OR at least one numeric field
 *   - numeric fields accept strings with commas/underscores/whitespace
 *   - negative values rejected as 422
 *
 * Usage `line` strings pass through a sanitizer that strips ANSI control
 * sequences, collapses whitespace, and trims to the "token usage:" portion.
 * Hard cap at ~1000 chars.
 */

export interface UsageEntry {
  line: string | null;
  total: number | null;
  input: number | null;
  output: number | null;
  cached: number | null;
  reasoning: number | null;
  model: string | null;
}

export interface RecordUsageResult {
  host_id: number;
  engine: Engine;
  recorded: number;
  usages: Array<UsageEntry & { engine: Engine; recorded_at: string }>;
  ingest_id: number | null;
  line?: string | null;
  total?: number | null;
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  reasoning?: number | null;
  model?: string | null;
  recorded_at?: string;
}

export interface TokenUsageService {
  record(hostId: number, payload: Record<string, unknown>, clientIp: string | null): Promise<RecordUsageResult>;
  totalsForMonth(
    hostId: number,
  ): Promise<{ total: number; input: number; output: number; cached: number; reasoning: number }>;
}

export interface TokenUsageDeps {
  db: Database;
}

export function createTokenUsageService(deps: TokenUsageDeps): TokenUsageService {
  const { db } = deps;
  return {
    async record(hostId, payload, clientIp) {
      const engine = parseEngine(payload.engine);
      const entries = normalizePayload(payload);
      const aggregates = {
        total: nullableAdd(entries, 'total'),
        input: nullableAdd(entries, 'input'),
        output: nullableAdd(entries, 'output'),
        cached: nullableAdd(entries, 'cached'),
        reasoning: nullableAdd(entries, 'reasoning'),
      };
      const recordedAt = nowIso();

      if (engine === ENGINE_CLAUDE) {
        for (const e of entries) if (!e.model) e.model = 'claude-sonnet-4-6';
      }

      const encoded = JSON.stringify({ engine, usages: entries });
      const ingestInsert = await db.insert(tokenUsageIngests).values({
        hostId,
        entries: entries.length,
        total: aggregates.total ?? undefined,
        inputTokens: aggregates.input ?? undefined,
        outputTokens: aggregates.output ?? undefined,
        cachedTokens: aggregates.cached ?? undefined,
        reasoningTokens: aggregates.reasoning ?? undefined,
        clientIp: clientIp || undefined,
        payload: encoded,
        createdAt: recordedAt,
        engine,
      });
      const ingestRaw = ingestInsert[0] as { insertId?: number | bigint } | undefined;
      const ingestId = ingestRaw?.insertId !== undefined ? Number(ingestRaw.insertId) : null;

      const recordedRows: Array<UsageEntry & { engine: Engine; recorded_at: string }> = [];
      for (const e of entries) {
        await db.insert(tokenUsages).values({
          hostId,
          ingestId: ingestId ?? undefined,
          total: e.total ?? undefined,
          inputTokens: e.input ?? undefined,
          outputTokens: e.output ?? undefined,
          cachedTokens: e.cached ?? undefined,
          reasoningTokens: e.reasoning ?? undefined,
          model: e.model ?? undefined,
          line: e.line ?? undefined,
          createdAt: recordedAt,
          engine,
        });
        recordedRows.push({ ...e, engine, recorded_at: recordedAt });
      }

      const out: RecordUsageResult = {
        host_id: hostId,
        engine,
        recorded: recordedRows.length,
        usages: recordedRows,
        ingest_id: ingestId,
      };
      if (recordedRows.length === 1) {
        const only = recordedRows[0]!;
        out.line = only.line;
        out.total = only.total;
        out.input = only.input;
        out.output = only.output;
        out.cached = only.cached;
        out.reasoning = only.reasoning;
        out.model = only.model;
        out.recorded_at = only.recorded_at;
      }
      return out;
    },

    async totalsForMonth(hostId) {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const startStr = start.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const endStr = end.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const rows = await db
        .select({
          total: sql<string>`COALESCE(SUM(${tokenUsages.total}),0)`,
          input: sql<string>`COALESCE(SUM(${tokenUsages.inputTokens}),0)`,
          output: sql<string>`COALESCE(SUM(${tokenUsages.outputTokens}),0)`,
          cached: sql<string>`COALESCE(SUM(${tokenUsages.cachedTokens}),0)`,
          reasoning: sql<string>`COALESCE(SUM(${tokenUsages.reasoningTokens}),0)`,
        })
        .from(tokenUsages)
        .where(
          and(
            eq(tokenUsages.hostId, hostId),
            gte(tokenUsages.createdAt, startStr),
            lt(tokenUsages.createdAt, endStr),
          ),
        );
      const r = rows[0] ?? { total: '0', input: '0', output: '0', cached: '0', reasoning: '0' };
      return {
        total: Number(r.total) || 0,
        input: Number(r.input) || 0,
        output: Number(r.output) || 0,
        cached: Number(r.cached) || 0,
        reasoning: Number(r.reasoning) || 0,
      };
    },
  };
}

function nullableAdd(entries: UsageEntry[], field: keyof UsageEntry): number | null {
  let sum: number | null = null;
  for (const e of entries) {
    const v = e[field];
    if (typeof v === 'number') sum = (sum ?? 0) + v;
  }
  return sum;
}

export function normalizePayload(payload: Record<string, unknown>): UsageEntry[] {
  const entries: UsageEntry[] = [];
  if (Array.isArray(payload.usages)) {
    for (let i = 0; i < payload.usages.length; i++) {
      const u = payload.usages[i];
      if (u && typeof u === 'object') {
        entries.push(normalizeEntry(u as Record<string, unknown>, `usages.${i}`));
      }
    }
  } else {
    entries.push(normalizeEntry(payload, 'usage'));
  }
  if (entries.length === 0) {
    throw new ValidationError('line or numeric fields are required', { param: 'line' });
  }
  return entries;
}

export function normalizeEntry(usage: Record<string, unknown>, path: string): UsageEntry {
  const rawLine = typeof usage.line === 'string' ? usage.line : '';
  const line = sanitizeLine(rawLine);
  const total = normalizeInt(usage.total, `${path}.total`);
  const input = normalizeInt(usage.input, `${path}.input`);
  const output = normalizeInt(usage.output, `${path}.output`);
  const cached = normalizeInt(usage.cached, `${path}.cached`, true);
  const reasoning = normalizeInt(usage.reasoning, `${path}.reasoning`, true);
  const model = typeof usage.model === 'string' ? usage.model.trim() : '';

  if (line === '' && total === null && input === null && output === null && cached === null && reasoning === null) {
    throw new ValidationError(`${path}: line or at least one numeric field is required`, { param: path });
  }
  return {
    line: line !== '' ? line : null,
    total,
    input,
    output,
    cached,
    reasoning,
    model: model !== '' ? model : null,
  };
}

// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC_RE = /\][^]*(|\\)/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[ -]/g;
// eslint-disable-next-line no-control-regex
const NON_PRINTABLE_RE = /[^ -~]/g;
const MULTI_BACKSLASH_RE = /\\{2,}/g;
const MOUSE_RE = /\[<\d+\w?/g;
const WHITESPACE_RE = /\s+/g;

export function sanitizeLine(line: string): string {
  let clean = line.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '');
  clean = clean.replace(CONTROL_RE, ' ');
  clean = clean.replace(MULTI_BACKSLASH_RE, '\\');
  clean = clean.replace(MOUSE_RE, '');
  clean = clean.replace(WHITESPACE_RE, ' ').trim();
  if (clean === '') return '';
  const usagePos = clean.toLowerCase().indexOf('token usage:');
  if (usagePos !== -1) clean = clean.slice(usagePos).trim();
  clean = clean.replace(NON_PRINTABLE_RE, '');
  if (clean.length > 1000) clean = clean.slice(0, 1000) + '…';
  return clean;
}

function normalizeInt(value: unknown, field: string, optional = false): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.replace(/[\s,_]/g, '');
    if (trimmed === '') return null;
    if (!/^\d+$/.test(trimmed)) {
      throw new ValidationError(`${field} must be a number (digits, optional commas)`, { param: field });
    }
    return parseInt(trimmed, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) throw new ValidationError(`${field} must be non-negative`, { param: field });
    return Math.floor(value);
  }
  if (optional) return null;
  throw new ValidationError(`${field} must be an integer`, { param: field });
}
