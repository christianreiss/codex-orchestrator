/**
 * Test doubles for `RunnerProxyService`.
 *
 * The service takes every collaborator as a required constructor dependency —
 * there is no "missing db" branch to fall through any more — so the doubles it
 * needs live here rather than being re-invented per spec file, and production
 * code carries no test seams.
 */

import type {
  CanonicalAuthStoreService,
  EnsureServedVerificationInput,
  EnsureServedVerificationResult,
} from '../../src/services/canonical-auth-store.js';
import type { Env } from '../../src/env.js';
import type { RunnerValidationService } from '../../src/services/runner-validation.js';
import {
  RunnerProxyService,
  createRunnerTelemetryReader,
  type RunnerProxyDeps,
  type RunnerTelemetryReader,
  type SeedTokenGrant,
  type SeedTokenStore,
} from '../../src/services/runner-proxy.js';
import type { Database } from '../../src/db/client.js';
import type { Engine } from '../../src/util/engine.js';

export function makeRunnerEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_RUNNER_URL: undefined,
    AUTH_RUNNER_SHARED_SECRET: undefined,
    ...(overrides as object),
  } as Env;
}

/** A configured, ready runner — the precondition for every `run()` case. */
export function readyRunnerEnv(overrides: Partial<Env> = {}): Env {
  return makeRunnerEnv({
    AUTH_RUNNER_URL: 'https://runner.example.com/verify',
    AUTH_RUNNER_SHARED_SECRET: 'secret',
    ...(overrides as object),
  } as Partial<Env>);
}

export interface CanonicalRowFake {
  id: number;
  engine: Engine;
  digest: string;
  lastRefresh: string;
  auth: Record<string, unknown>;
  verificationState?: 'pending' | 'verified' | 'failed';
}

export function canonicalRow(overrides: Partial<CanonicalRowFake> = {}): CanonicalRowFake {
  return {
    id: 42,
    engine: 'codex',
    digest: 'a'.repeat(64),
    lastRefresh: '2026-05-20T10:00:00Z',
    auth: { auths: { 'api.openai.com': { token: 'sk-test-token' } } },
    verificationState: 'verified',
    ...overrides,
  };
}

/**
 * A validation service backed by an in-memory canonical row per engine.
 * `null` for an engine means "no canonical auth", which is what the service
 * must report as unavailable rather than probing.
 */
export function fakeRunnerValidation(
  rows: Partial<Record<Engine, CanonicalRowFake | null>> = {},
): RunnerValidationService {
  const find = (engine: Engine) => rows[engine] ?? null;
  return {
    resolveCanonicalPayload: async (engine: Engine) => {
      const row = find(engine);
      if (!row) return null;
      return {
        id: row.id,
        engine: row.engine,
        sha256: row.digest,
        body: JSON.stringify(row.auth),
        lastRefresh: row.lastRefresh,
        createdAt: row.lastRefresh,
        verificationState: row.verificationState ?? 'verified',
        verificationCheckedAt: row.lastRefresh,
      };
    },
    validateCanonicalPayload: (payload: unknown) => {
      if (!payload) return null;
      const id = (payload as { id: number }).id;
      const row = Object.values(rows).find((candidate) => candidate?.id === id);
      if (!row) return null;
      return { auth: row.auth, digest: row.digest, last_refresh: row.lastRefresh };
    },
    canonicalAuthFromPayload: (payload: unknown) => {
      if (!payload) return null;
      const id = (payload as { id: number }).id;
      return Object.values(rows).find((candidate) => candidate?.id === id)?.auth ?? null;
    },
    ensureAuthsFallback: (payload: Record<string, unknown>) => payload,
    normalizeAuthEntries: () => [],
    hasUsableEngineCredential: () => true,
    canonicalizeAuthPayload: (payload: Record<string, unknown>) => payload,
    calculateDigest: () => 'a'.repeat(64),
  } as unknown as RunnerValidationService;
}

/** A canonical store whose verification verdict the test dictates outright. */
export function fakeAuthStore(
  verdict: Partial<EnsureServedVerificationResult> = {},
  onCall?: (input: unknown) => void,
): CanonicalAuthStoreService {
  return {
    storeCandidate: async () => {
      throw new Error('storeCandidate is not part of the manual runner path');
    },
    servedVerificationSnapshot: () => {
      throw new Error('servedVerificationSnapshot is not part of the manual runner path');
    },
    ensureServedVerification: async (input: EnsureServedVerificationInput) => {
      onCall?.(input);
      return {
        state: 'verified',
        auth: input.auth,
        digest: input.digest,
        lastRefresh: input.lastRefresh,
        refreshed: false,
        ...verdict,
      };
    },
  } as unknown as CanonicalAuthStoreService;
}

export function recordingSeedTokens(): SeedTokenStore & {
  purged: string[];
  issued: SeedTokenGrant[];
} {
  const purged: string[] = [];
  const issued: SeedTokenGrant[] = [];
  return {
    purged,
    issued,
    async purgeExpired(before: string) {
      purged.push(before);
    },
    async issue(grant: SeedTokenGrant) {
      issued.push(grant);
    },
  };
}

/**
 * The production telemetry reader, pointed at a `createDbFake` database.
 * Keeps the round-trip suites reading the real `versions` query rather than a
 * hand-written Map that could drift from it.
 */
export function createRunnerTelemetryReaderForFake(db: Database): RunnerTelemetryReader {
  return createRunnerTelemetryReader(db);
}

export function makeRunnerProxy(
  env: Env,
  overrides: Partial<RunnerProxyDeps> = {},
): RunnerProxyService {
  return new RunnerProxyService(env, undefined, {
    runnerValidation: fakeRunnerValidation(),
    authStore: fakeAuthStore(),
    seedTokens: recordingSeedTokens(),
    readTelemetry: async () => new Map<string, string>(),
    ...overrides,
  });
}
