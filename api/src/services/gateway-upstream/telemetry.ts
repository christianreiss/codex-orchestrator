/**
 * Provider key telemetry: `last_used_at` and the `last_error_*` columns.
 *
 * Reasons come from a fixed vocabulary plus an HTTP status, never from a
 * provider response body: the admin chooses `base_url`, so echoing what that
 * URL answered would turn the key list into an SSRF read oracle. `safeReason`
 * still redacts key-like tokens and caps at 255 characters as a backstop.
 *
 * Writes are coalesced for 30 seconds per owner (the `gateway-key-usage.ts`
 * pattern) and flushed under `withOwnerBackgroundScope`, so a gateway request's
 * principal never authorises them and a flush never cuts a client's stream.
 * No request or token accounting is recorded here.
 */
import { eq } from 'drizzle-orm';
import {
  mutateOwnerState,
  ownerRuntimeFor,
  withOwnerBackgroundScope,
  type OwnerRuntime,
} from '../../control-plane/state/runtime.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import type { Database } from '../../db/client.js';
import { providerApiKeys } from '../../db/schema.js';

export type UpstreamReason =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'restricted'
  | 'upstream_error'
  | 'unexpected_status'
  | 'unreachable'
  | 'timeout'
  | 'blocked_address'
  | 'invalid_response';

export const UPSTREAM_REASONS: readonly UpstreamReason[] = [
  'ok',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'restricted',
  'upstream_error',
  'unexpected_status',
  'unreachable',
  'timeout',
  'blocked_address',
  'invalid_response',
];

export const MAX_REASON_LENGTH = 255;

export function reasonForStatus(status: number): UpstreamReason {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'unexpected_status';
}

/** Key-shaped tokens: provider prefixes and long opaque runs. */
const KEY_LIKE = /\b(?:sk|xai|pk|rk|sess|key)[-_][A-Za-z0-9_-]{6,}|[A-Za-z0-9+/_-]{32,}={0,2}/gi;

export function safeReason(text: string): string {
  const redacted = text.replace(KEY_LIKE, '[redacted]');
  return redacted.length > MAX_REASON_LENGTH ? redacted.slice(0, MAX_REASON_LENGTH) : redacted;
}

/** `reason` or `reason (HTTP 401)`, always from the fixed vocabulary. */
export function describeReason(reason: UpstreamReason, status?: number | null): string {
  return safeReason(status ? `${reason} (HTTP ${status})` : reason);
}

interface PendingTelemetry {
  usedAt?: string;
  errorAt?: string;
  errorStatus?: number | null;
  errorReason?: string;
}

const buffers = new WeakMap<OwnerRuntime, Map<number, PendingTelemetry>>();
const DEADLINE = 'provider-key-telemetry';
const FLUSH_MS = 30_000;

function pending(owner: OwnerRuntime, id: number): PendingTelemetry | null {
  if (!owner.state.snapshot().table('providerApiKeys').has(id)) return null;
  let buffer = buffers.get(owner);
  if (!buffer) {
    buffer = new Map();
    buffers.set(owner, buffer);
  }
  if (buffer.size === 0) owner.deadlines.schedule(DEADLINE, Date.now() + FLUSH_MS, () => flushProviderKeyTelemetry(owner));
  let entry = buffer.get(id);
  if (!entry) {
    entry = {};
    buffer.set(id, entry);
  }
  return entry;
}

/** A committed answer was served with this key. */
export function recordProviderKeyUse(db: Database, id: number, at = new Date().toISOString()): void {
  const owner = ownerRuntimeFor(db);
  if (!owner) {
    void legacyUpdate(db, id, { lastUsedAt: at });
    return;
  }
  const entry = pending(owner, id);
  if (entry && (!entry.usedAt || at > entry.usedAt)) entry.usedAt = at;
}

/** A key-specific failure (connect error, 401/403/429, timeout). */
export function recordProviderKeyError(
  db: Database,
  id: number,
  reason: UpstreamReason,
  status: number | null,
  at = new Date().toISOString(),
): void {
  const owner = ownerRuntimeFor(db);
  const text = describeReason(reason, status);
  if (!owner) {
    void legacyUpdate(db, id, { lastErrorAt: at, lastErrorStatus: status, lastErrorReason: text });
    return;
  }
  const entry = pending(owner, id);
  if (entry && (!entry.errorAt || at >= entry.errorAt)) {
    entry.errorAt = at;
    entry.errorStatus = status;
    entry.errorReason = text;
  }
}

async function legacyUpdate(db: Database, id: number, patch: Partial<typeof providerApiKeys.$inferInsert>): Promise<void> {
  try {
    await db.update(providerApiKeys).set(patch).where(eq(providerApiKeys.id, id));
  } catch {
    /* best-effort telemetry */
  }
}

export function pendingProviderKeyTelemetry(owner: OwnerRuntime, id: number): Readonly<PendingTelemetry> | undefined {
  return buffers.get(owner)?.get(id);
}

export async function flushProviderKeyTelemetry(owner: OwnerRuntime): Promise<void> {
  const buffer = buffers.get(owner);
  if (!buffer?.size) return;
  const batch = new Map(buffer);
  buffer.clear();
  owner.deadlines.cancel(DEADLINE);
  try {
    await withOwnerBackgroundScope(() =>
      mutateOwnerState(owner, {
        kind: 'provider_key.telemetry',
        principal: 'system:provider-key-telemetry',
        payload: {
          keys: [...batch].map(([id, row]) => ({
            id,
            used_at: row.usedAt ?? null,
            error_at: row.errorAt ?? null,
            error_status: row.errorStatus ?? null,
            error_reason: row.errorReason ?? null,
          })),
        },
        prepare(ctx) {
          for (const [id, row] of batch) {
            const current = ctx.snapshot.table('providerApiKeys').get(id);
            if (!current) continue;
            const patch: Partial<typeof providerApiKeys.$inferInsert> = {};
            if (row.usedAt && (!current.lastUsedAt || row.usedAt > current.lastUsedAt)) patch.lastUsedAt = row.usedAt;
            if (row.errorAt && (!current.lastErrorAt || row.errorAt >= current.lastErrorAt)) {
              patch.lastErrorAt = row.errorAt;
              patch.lastErrorStatus = row.errorStatus ?? null;
              patch.lastErrorReason = row.errorReason ?? null;
            }
            if (Object.keys(patch).length) stageUpdate(ctx, 'providerApiKeys', id, patch);
          }
          return null;
        },
      }),
    );
  } catch (error) {
    // Keep observations when the command failed; newer ones win.
    for (const [id, row] of batch) {
      const newer = buffer.get(id) ?? {};
      buffer.set(id, {
        usedAt: newer.usedAt && (!row.usedAt || newer.usedAt > row.usedAt) ? newer.usedAt : row.usedAt,
        ...(newer.errorAt && (!row.errorAt || newer.errorAt >= row.errorAt)
          ? { errorAt: newer.errorAt, errorStatus: newer.errorStatus, errorReason: newer.errorReason }
          : { errorAt: row.errorAt, errorStatus: row.errorStatus, errorReason: row.errorReason }),
      });
    }
    owner.deadlines.schedule(DEADLINE, Date.now() + FLUSH_MS, () => flushProviderKeyTelemetry(owner));
    throw error;
  }
}
