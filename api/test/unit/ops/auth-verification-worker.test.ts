import { describe, expect, it, vi } from 'vitest';
import {
  probeBackoffSeconds,
  probeIntervalSeconds,
  isProbeDue,
  runAuthVerificationWorkerTick,
  type AuthProbeScheduleMemory,
} from '../../../src/ops/auth-verification-worker.js';
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

describe('dynamic probe schedule', () => {
  const T0 = Date.parse('2026-08-08T12:00:00Z');
  const iso = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString();

  it('probeIntervalSeconds grows with proven-good age, clamped to [ttl, max]', () => {
    const base = { ttlSeconds: 900, maxIntervalSeconds: 21600 };
    // Fresh row: checked at creation → minimum.
    expect(probeIntervalSeconds({ createdAt: iso(0), checkedAt: iso(0), ...base })).toBe(900);
    // Proven good for an hour → an hour.
    expect(probeIntervalSeconds({ createdAt: iso(0), checkedAt: iso(3600), ...base })).toBe(3600);
    // Proven good for 30000s → capped at 6h.
    expect(probeIntervalSeconds({ createdAt: iso(0), checkedAt: iso(30000), ...base })).toBe(21600);
    // Unparsable stamps → minimum.
    expect(probeIntervalSeconds({ createdAt: 'garbage', checkedAt: iso(0), ...base })).toBe(900);
    expect(probeIntervalSeconds({ createdAt: iso(0), checkedAt: null, ...base })).toBe(900);
    // max below ttl clamps up to ttl.
    expect(
      probeIntervalSeconds({ createdAt: iso(0), checkedAt: iso(9999), ttlSeconds: 900, maxIntervalSeconds: 60 }),
    ).toBe(900);
  });

  it('probeBackoffSeconds doubles per attempt and caps', () => {
    expect(probeBackoffSeconds(1, 900, 21600)).toBe(900);
    expect(probeBackoffSeconds(2, 900, 21600)).toBe(1800);
    expect(probeBackoffSeconds(5, 900, 21600)).toBe(14400);
    expect(probeBackoffSeconds(10, 900, 21600)).toBe(21600);
  });

  it('isProbeDue: future-skewed checkedAt is not due', () => {
    const verdict = isProbeDue({
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: iso(600), createdAt: iso(0) },
      digest: DIGEST,
      memory: undefined,
      nowMs: T0,
      ttlSeconds: 900,
      maxIntervalSeconds: 21600,
    });
    expect(verdict.due).toBe(false);
  });

  it('backs off a verified row that has proven itself (headline: no probe, telemetry kept fresh)', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail' }> = [];
    const ensureServedVerification = vi.fn();
    // Created 5h ago, last verified 1h ago → proven-good 4h → next probe at +4h.
    const row = canonicalRow('claude', 'verified', iso(-3600));
    row.createdAt = iso(-5 * 3600);

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({ claude: row }),
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: {
        write: async (engine, state) => {
          writes.push({ engine, state });
        },
      },
      ttlSeconds: 900,
      reason: 'interval',
      nowMs: () => T0,
    });

    expect(ensureServedVerification).not.toHaveBeenCalled();
    expect(writes).toEqual([{ engine: 'claude', state: 'ok' }]);
  });

  it('probes a verified row past its dynamic interval with unchanged ttlSeconds', async () => {
    const ensureServedVerification = vi.fn(async () => ({
      state: 'verified' as const,
      auth: AUTH,
      digest: DIGEST,
      lastRefresh: '2026-07-05T08:00:00Z',
      refreshed: false,
    }));
    // Created 90m ago, checked 60m ago → proven-good 30m → due after 30m; 60m elapsed.
    const row = canonicalRow('claude', 'verified', iso(-3600));
    row.createdAt = iso(-90 * 60);

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({ claude: row }),
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: { write: async () => undefined },
      ttlSeconds: 900,
      reason: 'interval',
      nowMs: () => T0,
    });

    expect(ensureServedVerification).toHaveBeenCalledTimes(1);
    expect(ensureServedVerification).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'claude', ttlSeconds: 900, forceLive: false }),
    );
  });

  it('gives pending quarantine rows first-sight-then-backoff instead of every tick', async () => {
    const memory: AuthProbeScheduleMemory = new Map();
    let nowMs = T0;
    const pending = canonicalRow('claude', 'pending', null);
    const ensureServedVerification = vi.fn(async () => ({
      state: 'unknown' as const,
      auth: AUTH,
      digest: DIGEST,
      lastRefresh: '2026-07-05T08:00:00Z',
      refreshed: false,
    }));
    const validation = {
      ...runnerValidation({}),
      resolvePendingQuarantine: async (engine: Engine) => (engine === 'claude' ? pending : null),
    };
    const tick = () =>
      runAuthVerificationWorkerTick({
        runnerValidation: validation,
        authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
        telemetry: { write: async () => undefined },
        ttlSeconds: 900,
        reason: 'interval',
        scheduleMemory: memory,
        nowMs: () => nowMs,
      });

    await tick(); // first sight → probe
    expect(ensureServedVerification).toHaveBeenCalledTimes(1);

    nowMs = T0 + 300_000; // next worker tick — inside the 900s backoff
    await tick();
    expect(ensureServedVerification).toHaveBeenCalledTimes(1);

    nowMs = T0 + 1000_000; // past the backoff
    await tick();
    expect(ensureServedVerification).toHaveBeenCalledTimes(2);
    expect(memory.get('claude')?.attempts).toBe(2);
  });

  it('demotes a stale verified row to the attempt ladder after an unknown outcome', async () => {
    const memory: AuthProbeScheduleMemory = new Map();
    let nowMs = T0;
    // Ancient row: due by the row schedule on every tick.
    const row = canonicalRow('claude', 'verified', iso(-24 * 3600));
    row.createdAt = iso(-48 * 3600);
    const ensureServedVerification = vi.fn(async () => ({
      state: 'unknown' as const,
      auth: AUTH,
      digest: DIGEST,
      lastRefresh: '2026-07-05T08:00:00Z',
      refreshed: false,
    }));
    const tick = () =>
      runAuthVerificationWorkerTick({
        runnerValidation: runnerValidation({ claude: row }),
        authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
        telemetry: { write: async () => undefined },
        ttlSeconds: 900,
        reason: 'interval',
        scheduleMemory: memory,
        nowMs: () => nowMs,
      });

    await tick();
    expect(ensureServedVerification).toHaveBeenCalledTimes(1);

    nowMs = T0 + 300_000; // runner outage continues; row still "due" by age
    await tick();
    expect(ensureServedVerification).toHaveBeenCalledTimes(1);

    nowMs = T0 + 1000_000;
    await tick();
    expect(ensureServedVerification).toHaveBeenCalledTimes(2);
  });

  it('clears the attempt memory once a verdict persists', async () => {
    const memory: AuthProbeScheduleMemory = new Map();
    const row = canonicalRow('claude', 'verified', iso(-24 * 3600));
    row.createdAt = iso(-48 * 3600);
    const ensureServedVerification = vi.fn(async () => ({
      state: 'verified' as const,
      auth: AUTH,
      digest: DIGEST,
      lastRefresh: '2026-07-05T08:00:00Z',
      refreshed: false,
    }));

    await runAuthVerificationWorkerTick({
      runnerValidation: runnerValidation({ claude: row }),
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: { write: async () => undefined },
      ttlSeconds: 900,
      reason: 'interval',
      scheduleMemory: memory,
      nowMs: () => T0,
    });

    expect(ensureServedVerification).toHaveBeenCalledTimes(1);
    expect(memory.get('claude')).toBeUndefined();
  });

  it('skips the probe entirely when it could only pass by spending refresh material', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail' }> = [];
    const ensureServedVerification = vi.fn();
    const expiredOauth = {
      last_refresh: '2026-07-05T08:00:00Z',
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-expired',
        refreshToken: 'live-refresh',
        expiresAt: T0 - 60_000,
        refreshTokenExpiresAt: T0 + 30 * 24 * 3600 * 1000,
      },
    };
    const row = canonicalRow('claude', 'verified', iso(-24 * 3600));
    const validation: RunnerValidationService = {
      ...runnerValidation({ claude: row }),
      validateCanonicalPayload: (candidate) =>
        candidate ? { auth: expiredOauth, digest: DIGEST, last_refresh: row.lastRefresh } : null,
      ensureAuthsFallback: () => expiredOauth,
      canonicalizeAuthPayload: () => expiredOauth,
    };

    await runAuthVerificationWorkerTick({
      runnerValidation: validation,
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: {
        write: async (engine, state) => {
          writes.push({ engine, state });
        },
      },
      ttlSeconds: 900,
      reason: 'interval',
      nowMs: () => T0,
    });

    // Ancient checkedAt would be "due", but the refresh-spend gate wins;
    // verified lineage keeps reporting ok so the dashboard stays truthful.
    expect(ensureServedVerification).not.toHaveBeenCalled();
    expect(writes).toEqual([{ engine: 'claude', state: 'ok' }]);
  });

  it('writes no telemetry when skipping an unverifiable pending row', async () => {
    const writes: Array<{ engine: Engine; state: 'ok' | 'fail' }> = [];
    const ensureServedVerification = vi.fn();
    const expiredOauth = {
      last_refresh: '2026-07-05T08:00:00Z',
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-expired',
        refreshToken: 'live-refresh',
        expiresAt: T0 - 60_000,
        refreshTokenExpiresAt: T0 + 30 * 24 * 3600 * 1000,
      },
    };
    const pending = canonicalRow('claude', 'pending', null);
    const validation: RunnerValidationService = {
      ...runnerValidation({ claude: pending }),
      validateCanonicalPayload: (candidate) =>
        candidate ? { auth: expiredOauth, digest: DIGEST, last_refresh: pending.lastRefresh } : null,
      ensureAuthsFallback: () => expiredOauth,
      canonicalizeAuthPayload: () => expiredOauth,
    };

    await runAuthVerificationWorkerTick({
      runnerValidation: validation,
      authStore: { ensureServedVerification } as unknown as CanonicalAuthStoreService,
      telemetry: {
        write: async (engine, state) => {
          writes.push({ engine, state });
        },
      },
      ttlSeconds: 900,
      reason: 'interval',
      nowMs: () => T0,
    });

    expect(ensureServedVerification).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
