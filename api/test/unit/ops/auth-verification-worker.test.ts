import { describe, expect, it, vi } from 'vitest';
import { runAuthVerificationWorkerTick } from '../../../src/ops/auth-verification-worker.js';
import type { CanonicalAuthStoreService } from '../../../src/services/canonical-auth-store.js';
import type { RunnerValidationService, CanonicalPayloadRow } from '../../../src/services/runner-validation.js';
import type { Engine } from '../../../src/util/engine.js';

const DIGEST = 'a'.repeat(64);
const AUTH = {
  last_refresh: '2026-07-05T08:00:00Z',
  auths: { 'api.anthropic.com': { token: 'sk-ant-test' } },
};

function canonicalRow(
  engine: Engine,
  verificationState: string,
  verificationCheckedAt: string | null,
): CanonicalPayloadRow {
  return {
    id: engine === 'claude' ? 22 : 11,
    lastRefresh: '2026-07-05T08:00:00Z',
    sha256: DIGEST,
    body: '{}',
    engine,
    createdAt: '2026-07-05T08:00:00Z',
    verificationState,
    verificationCheckedAt,
    verificationReason: null,
  };
}

function runnerValidation(rows: Partial<Record<Engine, CanonicalPayloadRow>>): RunnerValidationService {
  return {
    resolveCanonicalPayload: async (engine) => rows[engine] ?? null,
    validateCanonicalPayload: (row) =>
      row ? { auth: AUTH, digest: row.sha256, last_refresh: row.lastRefresh } : null,
    canonicalAuthFromPayload: () => AUTH,
    ensureAuthsFallback: (payload) => payload,
    normalizeAuthEntries: () => [],
    canonicalizeAuthPayload: (payload) => payload,
    calculateDigest: () => DIGEST,
  };
}

describe('auth verification worker tick', () => {
  it('updates Claude runner telemetry after a stale live verification succeeds', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail'; checkedAt: string }> = [];
    const ensureServedVerification = vi.fn(async () => ({
      state: 'verified' as const,
      auth: AUTH,
      digest: DIGEST,
      lastRefresh: '2026-07-05T08:00:00Z',
      refreshed: false,
    }));

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({
        codex: canonicalRow('codex', 'verified', new Date().toISOString()),
        claude: canonicalRow('claude', 'verified', '2026-07-05T08:00:00Z'),
      }),
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: {
        write: async (engine, state, checkedAt) => {
          writes.push({ engine, state, checkedAt });
        },
      },
      ttlSeconds: 60,
      reason: 'interval',
      now: () => '2026-07-05T10:00:00Z',
    });

    expect(ensureServedVerification).toHaveBeenCalledTimes(1);
    expect(ensureServedVerification).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude' }));
    expect(writes).toEqual([{ engine: 'claude', state: 'ok', checkedAt: '2026-07-05T10:00:00Z' }]);
  });

  it('does not make unknown runner outages look like a fresh OK check', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail'; checkedAt: string }> = [];

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({
        claude: canonicalRow('claude', 'verified', '2026-07-05T08:00:00Z'),
      }),
      authStore: {
        ensureServedVerification: async () => ({
          state: 'unknown' as const,
          auth: AUTH,
          digest: DIGEST,
          lastRefresh: '2026-07-05T08:00:00Z',
          refreshed: false,
        }),
      } as unknown as CanonicalAuthStoreService,
      telemetry: {
        write: async (engine, state, checkedAt) => {
          writes.push({ engine, state, checkedAt });
        },
      },
      ttlSeconds: 60,
      reason: 'interval',
      now: () => '2026-07-05T10:00:00Z',
    });

    expect(writes).toEqual([]);
  });
});
