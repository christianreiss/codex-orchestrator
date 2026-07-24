import { describe, expect, it, vi } from 'vitest';
import { runAuthVerificationWorkerTick } from '../../../src/ops/auth-verification-worker.js';
import type { CanonicalAuthStoreService } from '../../../src/services/canonical-auth-store.js';
import type {
  RunnerValidationService,
  CanonicalPayloadRow,
} from '../../../src/services/runner-validation.js';
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
    hasUsableEngineCredential: () => true,
    canonicalizeAuthPayload: (payload) => payload,
    calculateDigest: () => DIGEST,
  };
}

describe('auth verification worker tick', () => {
  it('live-verifies normalized Codex bytes even when the legacy row verdict is fresh', async () => {
    const checkedAt = new Date().toISOString();
    const row = canonicalRow('codex', 'verified', checkedAt);
    const rawAuth = {
      last_refresh: row.lastRefresh,
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
      tokens: { access_token: 'old-runner-oauth-winner-123' },
      auths: { 'api.openai.com': { token: 'old-runner-oauth-winner-123' } },
    };
    const normalizedAuth = {
      last_refresh: row.lastRefresh,
      auths: { 'api.openai.com': { token: 'sk-native-api-key-winner-123' } },
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
    };
    const ensureServedVerification = vi.fn(async () => ({
      state: 'verified' as const,
      auth: normalizedAuth,
      digest: 'b'.repeat(64),
      lastRefresh: row.lastRefresh,
      refreshed: true,
    }));
    const validation: RunnerValidationService = {
      resolveCanonicalPayload: async (engine) => (engine === 'codex' ? row : null),
      validateCanonicalPayload: (candidate) =>
        candidate ? { auth: rawAuth, digest: DIGEST, last_refresh: row.lastRefresh } : null,
      canonicalAuthFromPayload: () => null,
      ensureAuthsFallback: () => rawAuth,
      normalizeAuthEntries: () => [],
      hasUsableEngineCredential: () => true,
      canonicalizeAuthPayload: () => normalizedAuth,
      calculateDigest: (body) => (body.includes('"auth_mode":"apikey"') ? 'b'.repeat(64) : DIGEST),
    };

    await runAuthVerificationWorkerTick({
      runnerValidation: validation,
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: { write: async () => undefined },
      ttlSeconds: 900,
      reason: 'interval',
    });

    expect(ensureServedVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'codex',
        auth: normalizedAuth,
        digest: DIGEST,
        forceLive: true,
      }),
    );
  });

  it('updates Claude runner telemetry after a stale live verification succeeds', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail'; checkedAt: string }> = [];
    const ensureServedVerification = vi.fn(async () => ({
      state: 'verified' as const,
      auth: AUTH,
      digest: DIGEST,
      lastRefresh: '2026-07-05T08:00:00Z',
      refreshed: false,
    }));

    // codex must be fresh relative to the real Date.now() the code checks
    // against (needsLiveVerification uses the wall clock, not deps.now), so
    // capture "now" rather than hand-picking a fixed timestamp.
    const codexCheckedAt = new Date().toISOString();

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({
        codex: canonicalRow('codex', 'verified', codexCheckedAt),
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
    // codex is still within its TTL, so it takes the probe-free fast path —
    // but that path must still report telemetry matching the row's last
    // known state, not silently skip it.
    expect(writes).toEqual([
      { engine: 'codex', state: 'ok', checkedAt: codexCheckedAt },
      { engine: 'claude', state: 'ok', checkedAt: '2026-07-05T10:00:00Z' },
    ]);
  });

  it('reports telemetry on the fast (still-fresh) path instead of leaving it stale', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail'; checkedAt: string }> = [];
    const ensureServedVerification = vi.fn();
    const claudeCheckedAt = new Date().toISOString();

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({
        claude: canonicalRow('claude', 'failed', claudeCheckedAt),
      }),
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: {
        write: async (engine, state, checkedAt) => {
          writes.push({ engine, state, checkedAt });
        },
      },
      ttlSeconds: 900,
      reason: 'interval',
      now: () => '2026-07-05T10:00:00Z',
    });

    // Within TTL of a 'failed' row uploaded/verified outside this worker
    // (e.g. a host's own auth-upload superseded it) — no live probe needed,
    // but telemetry must reflect that resolved state, not skip silently.
    expect(ensureServedVerification).not.toHaveBeenCalled();
    expect(writes).toEqual([{ engine: 'claude', state: 'fail', checkedAt: claudeCheckedAt }]);
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

  it('does not report OK when the queued canonical changed to pending', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail'; checkedAt: string }> = [];

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({
        claude: canonicalRow('claude', 'verified', '2026-07-05T08:00:00Z'),
      }),
      authStore: {
        ensureServedVerification: async () => ({
          state: 'unknown' as const,
          auth: AUTH,
          digest: 'b'.repeat(64),
          lastRefresh: '2026-07-05T09:00:00Z',
          // Legacy selection-change behavior used this flag even though the
          // newly selected row had never received a live verdict.
          refreshed: true,
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
