import { describe, expect, it, vi } from 'vitest';
import { createAuthTrafficVerifier } from '../../../src/services/auth-traffic-verification.js';
import type { Database } from '../../../src/db/client.js';
import type {
  CanonicalPayloadRow,
  RunnerValidationService,
} from '../../../src/services/runner-validation.js';

const AUTH = { claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } };

function row(id: number, verificationState = 'verified'): CanonicalPayloadRow {
  return {
    id,
    lastRefresh: '2026-08-08T12:00:00Z',
    sha256: 'a'.repeat(64),
    body: '{}',
    engine: 'claude',
    createdAt: '2026-08-08T12:00:00Z',
    verificationState,
    verificationCheckedAt: '2026-08-08T12:00:00Z',
    verificationReason: null,
  };
}

function recordingDb() {
  const updates: Array<{ vals: Record<string, unknown> }> = [];
  const executes: unknown[] = [];
  let failUpdates = false;
  let affectedRows = 1;
  const db = {
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          if (failUpdates) return Promise.reject(new Error('db down'));
          updates.push({ vals });
          return Promise.resolve([{ affectedRows }]);
        },
      }),
    }),
    execute: (q: unknown) => {
      executes.push(q);
      return Promise.resolve([]);
    },
  };
  return {
    db: db as unknown as Database,
    updates,
    executes,
    setFailUpdates: (v: boolean) => {
      failUpdates = v;
    },
    setAffectedRows: (v: number) => {
      affectedRows = v;
    },
  };
}

function validation(
  resolve: () => CanonicalPayloadRow | null,
  authFor: (r: CanonicalPayloadRow) => unknown | null = () => AUTH,
): RunnerValidationService {
  return {
    resolveCanonicalPayload: async () => resolve(),
    canonicalAuthFromPayload: (r: unknown) => authFor(r as CanonicalPayloadRow),
  } as unknown as RunnerValidationService;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createAuthTrafficVerifier', () => {
  it('touches the served row and writes telemetry after a successful exec', async () => {
    const { db, updates, executes } = recordingDb();
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => row(7)),
      engine: 'claude',
      now: () => '2026-08-08T13:00:00Z',
      nowMs: () => 1_000_000,
    });

    const snapshot = await verifier.getAuthSnapshot();
    expect(snapshot).toEqual(AUTH);
    verifier.recordExecSuccess(snapshot);
    await settle();

    expect(updates).toEqual([{ vals: { verificationCheckedAt: '2026-08-08T13:00:00Z' } }]);
    // writeRunnerTelemetry issues three upserts (state, last_check, last_ok).
    expect(executes.length).toBe(3);
  });

  it('rate-limits touches to one per interval', async () => {
    const { db, updates } = recordingDb();
    let nowMs = 1_000_000;
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => row(7)),
      engine: 'claude',
      nowMs: () => nowMs,
    });
    const snapshot = await verifier.getAuthSnapshot();

    verifier.recordExecSuccess(snapshot);
    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(updates.length).toBe(1);

    nowMs += 61_000;
    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(updates.length).toBe(2);
  });

  it('does not touch when the canonical head moved or is no longer verified', async () => {
    const { db, updates } = recordingDb();
    let head = row(7);
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => head),
      engine: 'claude',
      nowMs: () => 1_000_000,
    });
    const snapshot = await verifier.getAuthSnapshot();

    head = row(8); // a newer upload superseded the served row
    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(updates.length).toBe(0);
  });

  it('does not touch a row that lost its verified state', async () => {
    const { db, updates } = recordingDb();
    let state = 'verified';
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => row(7, state)),
      engine: 'claude',
      nowMs: () => 1_000_000,
    });
    const snapshot = await verifier.getAuthSnapshot();

    state = 'failed';
    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(updates.length).toBe(0);
  });

  it('no-ops when no snapshot was ever served', async () => {
    const { db, updates } = recordingDb();
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => null),
      engine: 'claude',
      nowMs: () => 1_000_000,
    });

    const snapshot = await verifier.getAuthSnapshot();
    expect(snapshot).toBeNull();
    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(updates.length).toBe(0);
  });

  it('swallows touch failures with a debug log', async () => {
    const { db, setFailUpdates } = recordingDb();
    const debug = vi.fn();
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => row(7)),
      engine: 'claude',
      nowMs: () => 1_000_000,
      log: { debug },
    });
    const snapshot = await verifier.getAuthSnapshot();
    setFailUpdates(true);

    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude' }),
      'traffic verification touch failed',
    );
  });

  it.each(['codex', 'claude'] as const)(
    'does not credit an overlapping %s request with another request\'s generation',
    async (engine) => {
      const { db, updates, executes } = recordingDb();
      let head = row(7);
      const verifier = createAuthTrafficVerifier({
        db,
        runnerValidation: validation(() => head),
        engine,
        nowMs: () => 1_000_000,
      });
      const olderRequest = await verifier.getAuthSnapshot();
      head = row(8);
      const newerRequest = await verifier.getAuthSnapshot();

      // Request A completes after B loaded the replacement credential. A's
      // success proves only the old generation, even while B is still running.
      verifier.recordExecSuccess(olderRequest);
      await settle();
      expect(updates).toHaveLength(0);
      expect(executes).toHaveLength(0);

      // Rejected stale proof must not consume the new generation's throttle.
      verifier.recordExecSuccess(newerRequest);
      await settle();
      expect(updates).toHaveLength(1);
      expect(executes).toHaveLength(3);
    },
  );

  it('ignores credentials that did not come from this verifier', async () => {
    const { db, updates, executes } = recordingDb();
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => row(7)),
      engine: 'claude',
      nowMs: () => 1_000_000,
    });
    const snapshot = await verifier.getAuthSnapshot();
    verifier.recordExecSuccess(structuredClone(snapshot));
    await settle();
    expect(updates).toHaveLength(0);
    expect(executes).toHaveLength(0);

    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(updates).toHaveLength(1);
  });

  it('does not report runner OK when the row loses eligibility before the touch', async () => {
    const { db, updates, executes, setAffectedRows } = recordingDb();
    const verifier = createAuthTrafficVerifier({
      db,
      runnerValidation: validation(() => row(7)),
      engine: 'claude',
      nowMs: () => 1_000_000,
    });
    const snapshot = await verifier.getAuthSnapshot();
    // A worker verdict or a superseding store wins after the head read; the
    // conditional UPDATE then affects no eligible row.
    setAffectedRows(0);
    verifier.recordExecSuccess(snapshot);
    await settle();
    expect(updates).toHaveLength(1);
    expect(executes).toHaveLength(0);
  });
});
