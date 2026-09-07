// Traffic-as-verification: a successful gateway exec ran a real completion
// with the canonical credential, which proves the token live at zero extra
// cost. Touching verificationCheckedAt moves the verification worker's
// dynamic probe schedule forward, so background probes only fire when the
// fleet is idle. The launch gate is untouched — it serves on the stored
// verdict alone and never reads the timestamp.
import { and, eq, isNull } from 'drizzle-orm';
import { authPayloads } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Engine } from '../util/engine.js';
import type { RunnerValidationService } from './runner-validation.js';
import { writeRunnerTelemetry } from './runner-telemetry.js';
import { nowIso } from '../util/timestamp.js';

export interface AuthTrafficVerifier {
  /**
   * Drop-in canonical-snapshot provider for the gateway adapters. Associates
   * each returned snapshot with the verified payload row it came from.
   */
  getAuthSnapshot(): Promise<unknown | null>;
  /** Fire-and-forget, rate-limited; pass the exact snapshot used by the exec. */
  recordExecSuccess(snapshot: unknown): void;
}

export interface AuthTrafficVerifierDeps {
  db: Database;
  runnerValidation: RunnerValidationService;
  engine: Engine;
  /** Minimum gap between touches; default one minute. */
  minIntervalMs?: number;
  now?: () => string;
  nowMs?: () => number;
  log?: { debug?: (obj: unknown, msg: string) => void };
}

export function createAuthTrafficVerifier(deps: AuthTrafficVerifierDeps): AuthTrafficVerifier {
  const { db, runnerValidation, engine } = deps;
  const minIntervalMs = deps.minIntervalMs ?? 60_000;
  const now = deps.now ?? nowIso;
  const nowMs = deps.nowMs ?? Date.now;
  const servedRows = new WeakMap<object, number>();
  let lastTouchRowId: number | null = null;
  let lastTouchMs = -Infinity;

  return {
    async getAuthSnapshot(): Promise<unknown | null> {
      const row = await runnerValidation.resolveCanonicalPayload(engine);
      const auth = row ? runnerValidation.canonicalAuthFromPayload(row) : null;
      if (auth === null || row === null) return null;
      // Give every request a distinct identity, even if a provider caches its
      // decoded object. Weak keys retain no credential after the request ends.
      const snapshot = { ...auth };
      servedRows.set(snapshot, row.id);
      return snapshot;
    },

    recordExecSuccess(snapshot: unknown): void {
      if (snapshot === null || typeof snapshot !== 'object') return;
      const rowId = servedRows.get(snapshot);
      if (rowId === undefined) return;
      // Optimistic synchronous guard: concurrent successes inside the window
      // collapse to one touch without awaiting anything on the request path.
      const at = nowMs();
      if (rowId === lastTouchRowId && at - lastTouchMs < minIntervalMs) return;
      void (async () => {
        // Only touch the row the snapshot came from, and only while it is
        // still the verified canonical head — traffic proof must never
        // resurrect a failed or pending lineage.
        const head = await runnerValidation.resolveCanonicalPayload(engine);
        if (!head || head.id !== rowId || head.verificationState !== 'verified') return;
        // A stale completion must neither credit nor throttle the replacement.
        // Recheck after the read so concurrent first successes still coalesce.
        const checkedAt = nowMs();
        if (rowId === lastTouchRowId && checkedAt - lastTouchMs < minIntervalMs) return;
        lastTouchRowId = rowId;
        lastTouchMs = checkedAt;
        const ts = now();
        const touched = await db
          .update(authPayloads)
          .set({ verificationCheckedAt: ts })
          .where(
            and(
              eq(authPayloads.id, rowId),
              eq(authPayloads.verificationState, 'verified'),
              isNull(authPayloads.supersededAt),
            ),
          );
        // A concurrent failure or replacement may have won after the head
        // lookup. A skipped touch supplies no runner-health proof.
        if (Number(touched[0]?.affectedRows ?? 0) === 0) return;
        await writeRunnerTelemetry(db, engine, 'ok', ts);
      })().catch((err) => deps.log?.debug?.({ err, engine }, 'traffic verification touch failed'));
    },
  };
}
