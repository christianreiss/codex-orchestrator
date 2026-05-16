import { eq } from 'drizzle-orm';
import {
  authPayloads,
  authEntries,
  hostAuthStates,
  type Host,
  type AuthPayload,
  type AuthEntry,
} from '../../../src/db/schema.js';
import { sha256 } from '../../../src/security/hash.js';
import { nowIso } from '../../../src/util/timestamp.js';
import type { TestDb } from '../test-db.js';

export interface MakeAuthPayloadOverrides {
  body?: string;
  engine?: 'codex' | 'claude';
  /** Pre-hashed sha256 override; defaults to sha256(body). */
  sha256?: string;
  verificationState?: 'pending' | 'verified' | 'rejected';
  /**
   * Pass to also insert one or more auth_entries for the payload (the typical
   * test case — a payload is meaningless without at least one entry).
   */
  entries?: Array<Partial<AuthEntry> & { target?: string; token?: string }>;
  /**
   * Pass to also insert/update the host_auth_states row tying the host to
   * this payload (so requireHost + the payload model match end-to-end).
   */
  bindHost?: boolean;
}

export interface MakeAuthPayloadResult {
  payload: AuthPayload;
  entries: AuthEntry[];
}

/**
 * Inserts an auth_payloads row + at least one auth_entries row + optionally a
 * host_auth_states row. Models the common shape exercised by /auth/store and
 * /auth/retrieve.
 */
export async function makeAuthPayload(
  db: TestDb,
  host: Host,
  overrides: MakeAuthPayloadOverrides = {},
): Promise<MakeAuthPayloadResult> {
  const body = overrides.body ?? JSON.stringify({ marker: 'test', issued_at: nowIso() });
  const digest = overrides.sha256 ?? sha256(body);
  const engine = overrides.engine ?? 'codex';
  const now = nowIso();

  await db.insert(authPayloads).values({
    lastRefresh: now,
    sha256: digest,
    sourceHostId: host.id,
    createdAt: now,
    body,
    verificationState: overrides.verificationState ?? 'pending',
    engine,
  });
  const [payload] = await db
    .select()
    .from(authPayloads)
    .where(eq(authPayloads.sha256, digest))
    .limit(1);
  if (!payload) throw new Error('makeAuthPayload: row not found after insert');

  const entriesInput = overrides.entries ?? [{ target: 'chatgpt', token: 'tok-test-default' }];
  const entries: AuthEntry[] = [];
  for (const e of entriesInput) {
    await db.insert(authEntries).values({
      payloadId: payload.id,
      target: e.target ?? 'chatgpt',
      token: e.token ?? 'tok-test',
      tokenType: e.tokenType ?? 'bearer',
      organization: e.organization ?? null,
      project: e.project ?? null,
      apiBase: e.apiBase ?? null,
      meta: e.meta ?? null,
      createdAt: now,
    });
    const [row] = await db
      .select()
      .from(authEntries)
      .where(eq(authEntries.payloadId, payload.id))
      .orderBy(authEntries.id)
      .limit(50);
    if (row) entries.push(row);
  }

  if (overrides.bindHost) {
    await db.insert(hostAuthStates).values({
      hostId: host.id,
      payloadId: payload.id,
      seenDigest: digest,
      seenAt: now,
      engine,
    });
  }

  return { payload, entries };
}
