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
  const db = {
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: () => {
          if (failUpdates) return Promise.reject(new Error('db down'));
          updates.push({ vals });
          return Promise.resolve([{ affectedRows: 1 }]);
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
  };
}

function validation(
  resolve: () => CanonicalPayloadRow | null,
  authFor: (r: CanonicalPayloadRow) => unknown | null = () => AUTH,
): RunnerValidationService {
  return {
    resolveCanonicalPayload: async () => resolve(),
    canonicalAuthFromPayload: (r) => authFor(r as CanonicalPayloadRow),
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

    expect(await verifier.getAuthSnapshot()).toEqual(AUTH);
    verifier.recordExecSuccess();
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
    await verifier.getAuthSnapshot();

    verifier.recordExecSuccess();
    verifier.recordExecSuccess();
    await settle();
    expect(updates.length).toBe(1);

    nowMs += 61_000;
    verifier.recordExecSuccess();
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
    await verifier.getAuthSnapshot();

    head = row(8); // a newer upload superseded the served row
    verifier.recordExecSuccess();
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
    await verifier.getAuthSnapshot();

    state = 'failed';
    verifier.recordExecSuccess();
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

    expect(await verifier.getAuthSnapshot()).toBeNull();
    verifier.recordExecSuccess();
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
    await verifier.getAuthSnapshot();
    setFailUpdates(true);

    verifier.recordExecSuccess();
    await settle();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude' }),
      'traffic verification touch failed',
    );
  });
});
