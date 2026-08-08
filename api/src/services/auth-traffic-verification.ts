// Traffic-as-verification: a successful gateway exec ran a real completion
// with the canonical credential, which proves the token live at zero extra
// cost. Touching verificationCheckedAt moves the verification worker's
// dynamic probe schedule forward, so background probes only fire when the
// fleet is idle. The launch gate is untouched — it serves on the stored
// verdict alone and never reads the timestamp.
import { and, eq } from 'drizzle-orm';
import { authPayloads } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Engine } from '../util/engine.js';
import type { RunnerValidationService } from './runner-validation.js';
import { writeRunnerTelemetry } from './runner-telemetry.js';
import { nowIso } from '../util/timestamp.js';

export interface AuthTrafficVerifier {
  /**
   * Drop-in canonical-snapshot provider for the gateway adapters; remembers
   * which payload row the snapshot came from. `canonicalAuthFromPayload`
   * returns null for anything not verified, so the remembered id only ever
   * points at a row that was verified at serve time.
   */
  getAuthSnapshot(): Promise<unknown | null>;
  /** Fire-and-forget, rate-limited; call after a successful runner exec. */
  recordExecSuccess(): void;
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
  let lastServedRowId: number | null = null;
  let lastTouchMs = 0;

  return {
    async getAuthSnapshot(): Promise<unknown | null> {
      const row = await runnerValidation.resolveCanonicalPayload(engine);
      const auth = row ? runnerValidation.canonicalAuthFromPayload(row) : null;
      lastServedRowId = auth !== null && row !== null ? row.id : null;
      return auth;
    },

    recordExecSuccess(): void {
      // Optimistic synchronous guard: concurrent successes inside the window
      // collapse to one touch without awaiting anything on the request path.
      const at = nowMs();
      if (at - lastTouchMs < minIntervalMs) return;
      lastTouchMs = at;
      const rowId = lastServedRowId;
      if (rowId === null) return;
      void (async () => {
        // Only touch the row the snapshot came from, and only while it is
        // still the verified canonical head — traffic proof must never
        // resurrect a failed or pending lineage.
        const head = await runnerValidation.resolveCanonicalPayload(engine);
        if (!head || head.id !== rowId || head.verificationState !== 'verified') return;
        const ts = now();
        await db
          .update(authPayloads)
          .set({ verificationCheckedAt: ts })
          .where(and(eq(authPayloads.id, rowId), eq(authPayloads.verificationState, 'verified')));
        await writeRunnerTelemetry(db, engine, 'ok', ts);
      })().catch((err) => deps.log?.debug?.({ err, engine }, 'traffic verification touch failed'));
    },
  };
}
