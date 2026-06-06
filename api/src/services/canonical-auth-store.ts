import { and, eq } from 'drizzle-orm';
import {
  authEntries,
  authPayloads,
  hostAuthDigests,
  hostAuthStates,
  hosts as hostsTable,
  logs as logsTable,
} from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { encrypt } from '../security/secret-box.js';
import { ServiceUnavailableError, ValidationError } from '../http/errors.js';
import { isRfc3339, nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import type { RunnerClient } from './runner-client.js';
import type { RunnerValidationService, NormalizedAuthEntry } from './runner-validation.js';
import { ENGINE_CLAUDE } from '../util/engine.js';

const MIN_REFRESH_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 300 * 1000;

export interface CanonicalAuthStoreDeps {
  db: Database;
  keyring: Keyring;
  runnerValidation: RunnerValidationService;
  runner: RunnerClient;
}

export interface StoreAuthCandidateInput {
  auth: Record<string, unknown>;
  engine: Engine;
  sourceHostId: number | null;
  requireLastRefresh: boolean;
  logAction: string;
  logDetails?: Record<string, unknown>;
}

export interface StoreAuthCandidateResult {
  status: 'updated';
  auth: Record<string, unknown>;
  canonical_last_refresh: string;
  canonical_digest: string;
  verification_state: 'pending' | 'verified' | 'failed';
  pending_payload_id: number;
  runner_applied: boolean;
  runner_skipped_reason?: string;
  engine: Engine;
}

export interface CanonicalAuthStoreService {
  storeCandidate(input: StoreAuthCandidateInput): Promise<StoreAuthCandidateResult>;
}

export function createCanonicalAuthStoreService(deps: CanonicalAuthStoreDeps): CanonicalAuthStoreService {
  const { db, keyring, runnerValidation, runner } = deps;

  async function persistEntries(payloadId: number, entries: NormalizedAuthEntry[], now: string): Promise<void> {
    for (const e of entries) {
      await db.insert(authEntries).values({
        payloadId,
        target: e.target,
        token: encrypt(e.token, keyring),
        tokenType: e.tokenType ?? undefined,
        organization: e.organization ?? undefined,
        project: e.project ?? undefined,
        apiBase: e.apiBase ?? undefined,
        meta: e.meta ?? undefined,
        createdAt: now,
      });
    }
  }

  return {
    async storeCandidate(input) {
      const { engine } = input;
      const rawLastRefresh = typeof input.auth.last_refresh === 'string' ? input.auth.last_refresh.trim() : '';
      const lastRefresh = rawLastRefresh || (input.requireLastRefresh ? '' : nowIso());
      if (!lastRefresh) throw new ValidationError('last_refresh is required', { param: 'auth.last_refresh' });
      assertReasonableLastRefresh(lastRefresh, 'auth.last_refresh');

      const withFallback = runnerValidation.ensureAuthsFallback(input.auth, engine);
      const entries = runnerValidation.normalizeAuthEntries(withFallback, engine);
      if (entries.length === 0) {
        throw new ValidationError('payload contains no usable auth tokens', { param: 'auth' });
      }
      const canonical = runnerValidation.canonicalizeAuthPayload(withFallback, entries, lastRefresh);
      const encoded = JSON.stringify(canonical);

      let verificationState: 'pending' | 'verified' | 'failed' = 'pending';
      let canonicalToStore = canonical;
      let encodedToStore = encoded;
      let digestToStore = runnerValidation.calculateDigest(encoded);
      let entriesToStore = entries;
      let runnerApplied = false;
      let runnerSkippedReason: string | undefined;

      if (runner.isConfigured()) {
        const verdict =
          engine === ENGINE_CLAUDE
            ? await runner.verifyClaude({ authJson: canonical })
            : await runner.verify({ authJson: canonical });
        if (!verdict.ok) {
          throw new ServiceUnavailableError('Runner verification failed; store is gated', 'runner_unreachable');
        }
        verificationState = 'verified';
        const applied = prepareRunnerUpdatedAuth(
          verdict.updated_auth,
          lastRefresh,
          engine,
          runnerValidation,
        );
        if (applied.ok) {
          canonicalToStore = applied.canonical;
          encodedToStore = applied.encoded;
          digestToStore = applied.digest;
          entriesToStore = applied.entries;
          runnerApplied = true;
        } else if (applied.reason) {
          runnerSkippedReason = applied.reason;
        }
      }

      const now = nowIso();
      const lastRefreshToStore = String(canonicalToStore.last_refresh ?? lastRefresh);
      const ins = await db.insert(authPayloads).values({
        lastRefresh: lastRefreshToStore,
        sha256: digestToStore,
        sourceHostId: input.sourceHostId,
        createdAt: now,
        body: encrypt(encodedToStore, keyring),
        verificationState,
        verificationCheckedAt: verificationState === 'verified' ? now : null,
        verificationReason: runnerSkippedReason ?? null,
        engine,
      });
      const insertedRaw = ins[0] as { insertId?: number | bigint } | undefined;
      const payloadId = insertedRaw?.insertId !== undefined ? Number(insertedRaw.insertId) : 0;

      await persistEntries(payloadId, entriesToStore, now);

      if (input.sourceHostId !== null) {
        await db.insert(hostAuthDigests).values({
          hostId: input.sourceHostId,
          digest: digestToStore,
          lastSeen: now,
          createdAt: now,
          engine,
        });
        await touchHostAuthState(db, input.sourceHostId, payloadId, digestToStore, engine);
        await touchHostAuthFields(db, input.sourceHostId, lastRefreshToStore, digestToStore, engine);
      }

      await db.insert(logsTable).values({
        hostId: input.sourceHostId,
        action: input.logAction,
        details: JSON.stringify({
          status: 'updated',
          engine,
          digest: digestToStore,
          runner_applied: runnerApplied,
          ...(runnerSkippedReason ? { runner_skipped_reason: runnerSkippedReason } : {}),
          ...(input.logDetails ?? {}),
        }),
        createdAt: now,
      });

      return {
        status: 'updated',
        auth: canonicalToStore,
        canonical_last_refresh: lastRefreshToStore,
        canonical_digest: digestToStore,
        verification_state: verificationState,
        pending_payload_id: payloadId,
        runner_applied: runnerApplied,
        ...(runnerSkippedReason ? { runner_skipped_reason: runnerSkippedReason } : {}),
        engine,
      };
    },
  };
}

export async function touchHostAuthFields(
  db: Database,
  hostId: number,
  lastRefresh: string,
  digest: string,
  engine: Engine,
): Promise<void> {
  const now = nowIso();
  await db
    .update(hostsTable)
    .set(
      engine === ENGINE_CLAUDE
        ? { claudeLastRefresh: lastRefresh, claudeAuthDigest: digest, updatedAt: now }
        : { lastRefresh, authDigest: digest, updatedAt: now },
    )
    .where(eq(hostsTable.id, hostId));
}

export async function touchHostAuthState(
  db: Database,
  hostId: number,
  payloadId: number,
  digest: string,
  engine: Engine,
): Promise<void> {
  const now = nowIso();
  const existing = await db
    .select()
    .from(hostAuthStates)
    .where(and(eq(hostAuthStates.hostId, hostId), eq(hostAuthStates.engine, engine)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(hostAuthStates)
      .set({ payloadId, seenDigest: digest, seenAt: now })
      .where(and(eq(hostAuthStates.hostId, hostId), eq(hostAuthStates.engine, engine)));
  } else {
    await db.insert(hostAuthStates).values({ hostId, payloadId, seenDigest: digest, seenAt: now, engine });
  }
}

export function assertReasonableLastRefresh(value: string, field: string): void {
  if (!isRfc3339(value)) throw new ValidationError(`${field} must be an RFC3339 timestamp`, { param: field });
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) throw new ValidationError(`${field} must be an RFC3339 timestamp`, { param: field });
  if (ts < MIN_REFRESH_EPOCH_MS) throw new ValidationError(`${field} is implausibly old`, { param: field });
  if (ts > Date.now() + MAX_FUTURE_SKEW_MS) throw new ValidationError(`${field} is in the future`, { param: field });
}

function prepareRunnerUpdatedAuth(
  updatedAuth: unknown,
  uploadLastRefresh: string,
  engine: Engine,
  runnerValidation: RunnerValidationService,
):
  | {
      ok: true;
      canonical: Record<string, unknown>;
      encoded: string;
      digest: string;
      entries: NormalizedAuthEntry[];
    }
  | { ok: false; reason?: string } {
  if (!updatedAuth || typeof updatedAuth !== 'object' || Array.isArray(updatedAuth)) return { ok: false };
  const updated = updatedAuth as Record<string, unknown>;
  const updatedLast = typeof updated.last_refresh === 'string' ? updated.last_refresh.trim() : '';
  if (!updatedLast) return { ok: false, reason: 'updated_auth_missing_last_refresh' };
  try {
    assertReasonableLastRefresh(updatedLast, 'updated_auth.last_refresh');
  } catch {
    return { ok: false, reason: 'updated_auth_invalid_last_refresh' };
  }
  if (Date.parse(updatedLast) < Date.parse(uploadLastRefresh)) {
    return { ok: false, reason: 'updated_auth_older_than_upload' };
  }
  const withFallback = runnerValidation.ensureAuthsFallback(updated, engine);
  const entries = runnerValidation.normalizeAuthEntries(withFallback, engine);
  if (entries.length === 0) return { ok: false, reason: 'updated_auth_no_usable_tokens' };
  const canonical = runnerValidation.canonicalizeAuthPayload(withFallback, entries, updatedLast);
  const encoded = JSON.stringify(canonical);
  return {
    ok: true,
    canonical,
    encoded,
    digest: runnerValidation.calculateDigest(encoded),
    entries,
  };
}
