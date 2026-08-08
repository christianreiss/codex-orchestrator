import { eq } from 'drizzle-orm';
import {
  authCanonicalHeads,
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
import {
  compareRfc3339,
  formatRfc3339Nanos,
  isRfc3339,
  normalizeRfc3339Nanos,
  nowIso,
  parseRfc3339Millis,
  parseRfc3339Nanos,
} from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import type { RunnerClient } from './runner-client.js';
import type {
  CanonicalPayloadRow,
  NormalizedAuthEntry,
  RunnerValidationService,
} from './runner-validation.js';
import { ENGINE_CLAUDE } from '../util/engine.js';
import {
  accessCredentialExpired,
  compareCredentialFreshness,
  credentialMetadata,
  fingerprintMatches,
  inspectCredential,
  pairFingerprints,
  refreshCredentialExpired,
} from './auth-generation.js';
import { retentionDeadline } from './auth-generation-retention.js';

const MIN_REFRESH_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 300 * 1000;
// Treat a Claude access token as unverifiable slightly before its hard expiry
// so a probe never lands in the window where the CLI would want to refresh.
const CLAUDE_ACCESS_PROBE_MARGIN_MS = 300 * 1000;
// All route groups and the verification worker construct their own service
// instance. Keep the store coordinator process-wide so those independent
// instances still serialize a shared per-engine refresh-token lineage.
const engineStoreTails = new Map<Engine, Promise<void>>();
const verificationInflight = new Map<string, Promise<EnsureServedVerificationResult>>();

// Subset of Database used by the helpers below, satisfied by both a plain
// Database handle and a transaction handle (MySqlTransaction extends
// MySqlDatabase but lacks the `$client` property, so it isn't directly
// assignable to Database).
type DbLike = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

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
  /** Internal: the runner already produced this payload during re-verification. */
  runnerVerified?: boolean;
  /** Internal: the runner rotated to this payload but its final probe was retryable. */
  runnerPending?: boolean;
  /** Internal: the runner rotated to this payload before definitively rejecting it. */
  runnerFailed?: boolean;
  /** Internal failure detail persisted beside a runner-rejected replacement. */
  runnerFailureReason?: string;
  /** Internal CAS guard for runner-refreshed replacements. */
  expectedCanonicalDigest?: string;
  sourceKind?: 'host' | 'admin' | 'seed' | 'runner' | 'legacy';
  baseCanonicalGeneration?: number | null;
}

export interface StoreAuthCandidateResult {
  status: 'updated' | 'valid' | 'outdated';
  /** Present only when the selected payload has a stored verified verdict. */
  auth?: Record<string, unknown>;
  canonical_last_refresh: string;
  canonical_digest: string;
  verification_state: 'pending' | 'verified' | 'failed' | 'unknown';
  pending_payload_id: number;
  runner_applied: boolean;
  runner_skipped_reason?: string;
  engine: Engine;
  canonical_generation?: number;
  candidate_result?: 'accepted' | 'current' | 'historical_replay' | 'older_internal';
  candidate_rejected_definitive?: boolean;
}

export interface EnsureServedVerificationInput {
  engine: Engine;
  hostId: number | null;
  row: {
    id: number;
    verificationState: string;
    verificationCheckedAt: string | null;
    verificationReason?: string | null;
  };
  auth: Record<string, unknown>;
  digest: string;
  lastRefresh: string;
  ttlSeconds: number;
  /** Internal worker override when the exact stored bytes require normalization. */
  forceLive?: boolean;
  /** Reissue a live-verified generation whose body is safe but ledger metadata is not. */
  reissueCanonical?: boolean;
}

export interface EnsureServedVerificationResult {
  /**
   * verified — token chain proved live (cached within TTL, or freshly probed).
   * failed   — runner reached the provider and the credentials do not work.
   * unknown  — runner not configured or unreachable; caller keeps legacy
   *            offline/cached behaviour and must NOT treat this as proof.
   */
  state: 'verified' | 'failed' | 'unknown';
  auth: Record<string, unknown>;
  digest: string;
  lastRefresh: string;
  refreshed: boolean;
  reason?: string;
}

export interface CanonicalAuthStoreService {
  storeCandidate(input: StoreAuthCandidateInput): Promise<StoreAuthCandidateResult>;
  servedVerificationSnapshot(input: EnsureServedVerificationInput): EnsureServedVerificationResult;
  ensureServedVerification(input: EnsureServedVerificationInput): Promise<EnsureServedVerificationResult>;
}

export function createCanonicalAuthStoreService(deps: CanonicalAuthStoreDeps): CanonicalAuthStoreService {
  const { db, keyring, runnerValidation, runner } = deps;

  // In-process single-flight for the launch-gate live probe, keyed by
  // `${engine}:${payloadId}`. Without it, ~103 codex hosts hitting an
  // expired-but-refreshable canonical at the same moment each spawn a `codex
  // exec` probe and race the refresh-token rotation: the first rotates the
  // token, the rest reuse the now-dead one and get a false "refresh token
  // already used" → spurious `failed` verdicts and a fleet re-login storm. The
  // API runs single-instance, so collapsing concurrent probes here is enough.
  async function persistEntries(
    txDb: DbLike,
    payloadId: number,
    entries: NormalizedAuthEntry[],
    now: string,
  ): Promise<void> {
    for (const e of entries) {
      await txDb.insert(authEntries).values({
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

  async function storeCandidate(input: StoreAuthCandidateInput): Promise<StoreAuthCandidateResult> {
    return withEngineStoreLock(input.engine, () => storeCandidateLocked(input));
  }

  async function storeCandidateLocked(input: StoreAuthCandidateInput): Promise<StoreAuthCandidateResult> {
    const { engine } = input;
    const rawLastRefresh = typeof input.auth.last_refresh === 'string' ? input.auth.last_refresh.trim() : '';
    const suppliedLastRefresh = rawLastRefresh || (input.requireLastRefresh ? '' : nowIso());
    if (!suppliedLastRefresh) {
      throw new ValidationError('last_refresh is required', { param: 'auth.last_refresh' });
    }
    assertReasonableLastRefresh(suppliedLastRefresh, 'auth.last_refresh');
    const lastRefresh = normalizeLastRefresh(suppliedLastRefresh);

    const withFallback = runnerValidation.ensureAuthsFallback(input.auth, engine);
    const entries = runnerValidation.normalizeAuthEntries(withFallback, engine);
    if (!runnerValidation.hasUsableEngineCredential(withFallback, engine)) {
      throw new ValidationError('payload contains no usable auth tokens', { param: 'auth' });
    }

    const canonical = runnerValidation.canonicalizeAuthPayload(withFallback, entries, lastRefresh, engine);
    const encoded = JSON.stringify(canonical);
    const digest = runnerValidation.calculateDigest(encoded);

    const currentRow = await runnerValidation.resolveCanonicalPayload(engine);
    const current = runnerValidation.validateCanonicalPayload(currentRow);
    const currentDistributable = currentRow ? runnerValidation.canonicalAuthFromPayload(currentRow) : null;
    const sourceKind = input.sourceKind ?? (input.sourceHostId === null ? 'legacy' : 'host');
    const nonVerifiedRunnerReadback = input.runnerPending === true || input.runnerFailed === true;
    const candidateIdentity = inspectCredential(withFallback, engine);
    const currentIdentity = current ? inspectCredential(current.auth, engine) : null;
    if (!candidateIdentity) {
      throw new ValidationError('payload contains no inspectable engine credential', { param: 'auth' });
    }
    const candidateFingerprints = pairFingerprints(candidateIdentity, keyring);
    const history = await db.select().from(authPayloads).where(eq(authPayloads.engine, engine));
    const currentIdentityMatches = currentRow
      ? fingerprintMatches(
          currentRow.pairFingerprint,
          candidateFingerprints.get(currentRow.fingerprintKid ?? ''),
        )
      : false;
    const historicalIdentityMatch = history.find(
      (row) =>
        row.id !== currentRow?.id &&
        row.verificationState === 'verified' &&
        fingerprintMatches(row.pairFingerprint, candidateFingerprints.get(row.fingerprintKid ?? '')),
    );
    const newestUnresolvedQuarantine = history
      .filter(
        (row) =>
          row.verificationState !== 'verified' &&
          (currentRow === null || (row.generation ?? 0) > (currentRow.generation ?? 0)),
      )
      .sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0))[0];
    const quarantinedIdentityMatch =
      newestUnresolvedQuarantine?.verificationState === 'pending' &&
      fingerprintMatches(
        newestUnresolvedQuarantine.pairFingerprint,
        candidateFingerprints.get(newestUnresolvedQuarantine.fingerprintKid ?? ''),
      )
        ? newestUnresolvedQuarantine
        : undefined;
    if (
      !nonVerifiedRunnerReadback &&
      !input.runnerVerified &&
      currentIdentityMatches &&
      currentRow &&
      current &&
      currentRow.verificationState === 'verified' &&
      currentDistributable !== null
    ) {
      return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'valid', {
        generation: currentRow.generation ?? undefined,
        candidateResult: 'current',
      });
    }
    if (
      historicalIdentityMatch &&
      !quarantinedIdentityMatch &&
      currentRow?.verificationState === 'verified' &&
      current &&
      currentDistributable !== null
    ) {
      return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'outdated', {
        generation: currentRow.generation ?? undefined,
        candidateResult: 'historical_replay',
        definitive: currentRow.verificationState === 'verified',
      });
    }
    if (refreshCredentialExpired(candidateIdentity)) {
      if (
        !quarantinedIdentityMatch &&
        currentRow?.verificationState === 'verified' &&
        current &&
        currentDistributable !== null
      ) {
        return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'outdated', {
          generation: currentRow.generation ?? undefined,
          candidateResult: 'older_internal',
          definitive: currentRow.verificationState === 'verified',
        });
      }
      throw new ValidationError('credential refresh token is expired', { param: 'auth' });
    }
    const isExplicitDescendant =
      sourceKind === 'runner' || input.runnerVerified || input.runnerPending || input.runnerFailed;
    if (
      sourceKind === 'host' &&
      !isExplicitDescendant &&
      !quarantinedIdentityMatch &&
      currentIdentity &&
      currentRow?.verificationState === 'verified' &&
      current &&
      currentDistributable !== null
    ) {
      const freshness = compareCredentialFreshness(candidateIdentity, currentIdentity);
      if (freshness !== null && freshness <= 0) {
        return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'outdated', {
          generation: currentRow.generation ?? undefined,
          candidateResult: 'older_internal',
          definitive: currentRow.verificationState === 'verified',
        });
      }
    }
    if (
      (input.runnerVerified || input.runnerPending || input.runnerFailed) &&
      input.expectedCanonicalDigest &&
      currentRow &&
      current &&
      current.digest !== input.expectedCanonicalDigest
    ) {
      return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'outdated');
    }
    const runnerRefreshOfCurrent =
      (input.runnerVerified === true || input.runnerPending === true || input.runnerFailed === true) &&
      typeof input.expectedCanonicalDigest === 'string' &&
      current?.digest === input.expectedCanonicalDigest;
    let mustAdvanceSelectedStamp = false;
    const hasInternalRunnerVerdict =
      input.runnerVerified === true || input.runnerPending === true || input.runnerFailed === true;
    const canLiveVerify = hasInternalRunnerVerdict || runner.isConfigured();
    if (currentRow?.verificationState === 'failed' && !canLiveVerify) {
      throw new ServiceUnavailableError(
        'Auth runner unavailable; failed canonical cannot be replaced without live verification',
        'runner_unreachable',
      );
    }
    if (!hasInternalRunnerVerdict && !runner.isConfigured()) {
      throw new ServiceUnavailableError(
        'Auth runner unavailable; canonical store requires live verification',
        'runner_unreachable',
      );
    }
    // Pending/failed rows are quarantine, never distributable canonical
    // credentials. Only a live-verified candidate may repair that state.
    const currentRepairable =
      runnerRefreshOfCurrent ||
      (!nonVerifiedRunnerReadback && quarantinedIdentityMatch !== undefined && canLiveVerify) ||
      (currentRow?.verificationState === 'failed' && canLiveVerify) ||
      (currentRow?.verificationState === 'pending' && canLiveVerify) ||
      (currentRow?.verificationState === 'verified' && currentDistributable === null && canLiveVerify);
    if (currentRow && current) {
      if (digest === current.digest && !currentRepairable) {
        return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'valid');
      }
      const generationOrder = compareCanonicalStamps(lastRefresh, current.last_refresh);
      if (generationOrder < 0 && !currentRepairable) {
        return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'outdated');
      }
      // A proven/pending newest lineage must not make an older, still-valid
      // credential permanently unable to repair the fleet. If it verifies,
      // restamp it strictly after the failed/pending row. A different candidate
      // on an exact timestamp tie is likewise allowed through the live gate,
      // then restamped after verification. Deferring the restamp until after
      // the runner call lets native updated_auth legitimately echo the submitted
      // generation instead of looking older than a synthetic pre-probe stamp.
      if (generationOrder <= 0 && (currentRepairable || digest !== current.digest)) {
        mustAdvanceSelectedStamp = true;
      }
    }

    let verificationState: 'pending' | 'verified' | 'failed' = input.runnerVerified
      ? 'verified'
      : input.runnerFailed
        ? 'failed'
        : 'pending';
    let canonicalToStore = canonical;
    let encodedToStore = encoded;
    let digestToStore = digest;
    let entriesToStore = entries;
    let runnerApplied = false;
    let runnerSkippedReason = input.runnerFailureReason?.slice(0, 500);
    let postPersistError: ServiceUnavailableError | undefined;
    let invalidateSelectedReason: string | undefined;

    // A Claude OAuth candidate past its access-token lifetime cannot be
    // live-verified without spending its refresh token, and a probe-side spend
    // races host-side native refreshes of the same rotating grant (a replayed
    // spent token gets the whole family revoked — the fleet's daily forced
    // re-logins). Never probe such a candidate: a verified canonical wins
    // arbitration non-definitively, and without one the store stays gated
    // until the uploading host refreshes natively and re-submits.
    if (!hasInternalRunnerVerdict && claudeUnverifiableWithoutRefreshSpend(engine, candidateIdentity)) {
      if (currentRow?.verificationState === 'verified' && current && currentDistributable !== null) {
        return returnExisting(input, currentRow.id, currentRow.verificationState, current, 'outdated', {
          generation: currentRow.generation ?? undefined,
        });
      }
      throw new ServiceUnavailableError(
        'Claude access token expired; live verification would spend the refresh token. Awaiting native host refresh.',
        'candidate_unverifiable_expired',
      );
    }

    if (runner.isConfigured() && !input.runnerVerified && !input.runnerPending && !input.runnerFailed) {
      const verdict =
        engine === ENGINE_CLAUDE
          ? await runner.verifyClaude({ authJson: canonical })
          : await runner.verify({ authJson: canonical });
      const readbackFailure = runnerReadbackFailure(verdict);
      const applied = prepareRunnerUpdatedAuth(
        verdict.updated_auth,
        canonical,
        lastRefresh,
        engine,
        runnerValidation,
      );
      const definitiveUnusableReadback =
        !verdict.ok &&
        verdict.definitive === true &&
        (readbackFailure !== null || (verdict.updated_auth !== undefined && !applied.ok));
      if (definitiveUnusableReadback) {
        // Current native CLIs may clear their temporary credential file after
        // an explicit provider rejection. That is not a replacement lineage to
        // quarantine: the submitted credential is simply dead, and wrappers
        // must receive the normal 422 path so they can repair from canonical
        // auth or enter login recovery.
        throw new ValidationError(
          `auth candidate failed live verification${verdict.reason ? `: ${verdict.reason}` : ''}`,
          { param: 'auth' },
        );
      }
      if (readbackFailure) {
        throw new ServiceUnavailableError(
          `Auth runner could not safely read refreshed credentials: ${readbackFailure}`,
          'runner_updated_auth_invalid',
        );
      }
      if (verdict.updated_auth !== undefined && !applied.ok) {
        const reason = applied.reason ?? 'updated_auth_invalid';
        throw new ServiceUnavailableError(
          `Auth runner returned unusable refreshed credentials: ${reason}`,
          'runner_updated_auth_invalid',
        );
      }
      if (!verdict.ok) {
        // Native CLIs may rewrite formatting or drop wrapper-only fields while
        // leaving the selected credential unchanged. Canonicalization collapses
        // that harmless raw rewrite back to the submitted digest, so apply the
        // ordinary verdict semantics instead of quarantining an identical
        // credential generation as though a refresh had consumed it.
        if (!applied.ok || applied.digest === digest) {
          if (verdict.definitive) {
            throw new ValidationError(
              `auth candidate failed live verification${verdict.reason ? `: ${verdict.reason}` : ''}`,
              { param: 'auth' },
            );
          }
          throw new ServiceUnavailableError(
            'Auth runner unavailable; canonical store is gated',
            'runner_unreachable',
          );
        }
        // The native CLI changed its credential file before its final verdict.
        // Preserve that new lineage as pending after a retryable failure, or
        // failed after a definitive rejection; the submitted pre-refresh token
        // may already have been consumed and must never remain the only copy.
        canonicalToStore = applied.canonical;
        encodedToStore = applied.encoded;
        digestToStore = applied.digest;
        entriesToStore = applied.entries;
        verificationState = verdict.definitive ? 'failed' : 'pending';
        runnerApplied = true;
        runnerSkippedReason = `${
          verdict.definitive
            ? 'runner refreshed credentials then definitively rejected them'
            : 'runner refresh pending retry'
        }${verdict.reason ? `: ${verdict.reason}` : ''}`.slice(0, 500);
        if (
          currentRow?.verificationState === 'verified' &&
          currentIdentity &&
          sharesConsumableCredentialLineage(candidateIdentity, currentIdentity)
        ) {
          invalidateSelectedReason = `${
            verdict.definitive
              ? 'runner changed credentials before definitive rejection'
              : 'runner changed credentials before inconclusive verdict'
          }; prior selected credential may have been consumed${
            verdict.reason ? `: ${verdict.reason}` : ''
          }`.slice(0, 500);
        }
        postPersistError = new ServiceUnavailableError(
          verdict.definitive
            ? 'Auth runner refreshed credentials before rejecting them; replacement saved failed and requires login'
            : 'Auth runner refreshed credentials but the live probe was inconclusive; refresh saved pending retry',
          // Wrappers already classify this code as unsafe for offline fallback:
          // the pre-refresh local token may have been consumed even though the
          // replacement was safely retained server-side as pending or failed.
          'runner_updated_auth_invalid',
        );
      } else {
        verificationState = 'verified';
        if (applied.ok) {
          canonicalToStore = applied.canonical;
          encodedToStore = applied.encoded;
          digestToStore = applied.digest;
          entriesToStore = applied.entries;
          runnerApplied = true;
        }
      }
    }

    // Canonical digest changes must also advance the canonical timestamp. This
    // gives wrappers an ordering key for delayed response races, including a
    // runner rotation whose native file omitted last_refresh or retained the
    // submitted value. Auth ordering retains nanoseconds; synthetic rotations
    // advance by 1 ms for compatibility with existing clients. If the selected
    // lineage already occupies the +300s ceiling, nextCanonicalStamp fails
    // closed instead of minting an invalid future generation.
    if (
      current &&
      compareCanonicalStamps(String(canonicalToStore.last_refresh ?? lastRefresh), current.last_refresh) <=
        0 &&
      (mustAdvanceSelectedStamp || digestToStore !== current.digest)
    ) {
      const advancedStamp = nextCanonicalStamp(current.last_refresh, runnerRefreshOfCurrent || runnerApplied);
      canonicalToStore = runnerValidation.canonicalizeAuthPayload(
        canonicalToStore,
        entriesToStore,
        advancedStamp,
        engine,
      );
      encodedToStore = JSON.stringify(canonicalToStore);
      digestToStore = runnerValidation.calculateDigest(encodedToStore);
    }

    const lastRefreshToStore = String(canonicalToStore.last_refresh ?? lastRefresh);
    // Re-read after the potentially slow runner call. This is the CAS check
    // that prevents an in-flight stale probe from overwriting a newer store.
    const latestRow = await runnerValidation.resolveCanonicalPayload(engine);
    const latest = runnerValidation.validateCanonicalPayload(latestRow);
    if (latestRow && latest && latestRow.id !== currentRow?.id) {
      if (digestToStore === latest.digest) {
        return returnExisting(input, latestRow.id, latestRow.verificationState, latest, 'valid');
      }
      // The row changed while the runner call was in flight. Even if that new
      // row is pending/failed, it may represent a genuinely newer login. Only
      // the exact row observed before the probe may be repaired by restamping;
      // never leapfrog a different lineage during this final CAS.
      if (compareCanonicalStamps(lastRefreshToStore, latest.last_refresh) <= 0) {
        return returnExisting(input, latestRow.id, latestRow.verificationState, latest, 'outdated');
      }
    }

    const now = nowIso();
    const finalLastRefresh = String(canonicalToStore.last_refresh ?? lastRefreshToStore);
    const finalIdentity = inspectCredential(canonicalToStore, engine);
    if (!finalIdentity) {
      throw new ValidationError('canonical payload contains no inspectable credential', { param: 'auth' });
    }
    const finalMetadata = credentialMetadata(finalIdentity, keyring.active());
    const maxKnownGeneration = history.reduce((max, row) => Math.max(max, row.generation ?? 0), 0);
    const parentRow = latestRow ?? currentRow;
    const nextGeneration = Math.max(parentRow?.generation ?? 0, maxKnownGeneration) + 1;
    const promotesCanonical = verificationState === 'verified';
    let payloadId = 0;
    await db.transaction(async (tx) => {
      const ins = await tx.insert(authPayloads).values({
        lastRefresh: finalLastRefresh,
        sha256: digestToStore,
        sourceHostId: input.sourceHostId,
        createdAt: now,
        body: encrypt(encodedToStore, keyring),
        verificationState,
        verificationCheckedAt: verificationState === 'pending' ? null : now,
        verificationReason: runnerSkippedReason ?? null,
        engine,
        generation: nextGeneration,
        sourceKind,
        parentPayloadId: parentRow?.id ?? null,
        ...finalMetadata,
        supersededAt: promotesCanonical ? null : now,
        purgeAfter: promotesCanonical ? null : retentionDeadline(now),
      });
      const insertedRaw = ins[0] as { insertId?: number | bigint } | undefined;
      payloadId = insertedRaw?.insertId !== undefined ? Number(insertedRaw.insertId) : 0;

      if (invalidateSelectedReason && currentRow?.verificationState === 'verified') {
        // The native CLI already replaced the candidate before returning a
        // non-OK verdict. Its predecessor may have been consumed; atomically
        // fail the selected head while retaining the replacement in quarantine
        // so no retrieve can fleet stale pre-refresh bytes.
        const heads = await tx.select().from(authCanonicalHeads).where(eq(authCanonicalHeads.engine, engine));
        if (heads[0]?.payloadId === currentRow.id) {
          await tx
            .update(authPayloads)
            .set({
              verificationState: 'failed',
              verificationCheckedAt: now,
              verificationReason: invalidateSelectedReason,
            })
            .where(eq(authPayloads.id, currentRow.id));
        }
      }

      if (promotesCanonical && parentRow) {
        await tx
          .update(authPayloads)
          .set({ supersededAt: now, purgeAfter: retentionDeadline(now) })
          .where(eq(authPayloads.id, parentRow.id));
      }
      if (promotesCanonical) {
        const existingHead = await tx
          .select()
          .from(authCanonicalHeads)
          .where(eq(authCanonicalHeads.engine, engine));
        if (existingHead.length > 0) {
          await tx
            .update(authCanonicalHeads)
            .set({ payloadId, generation: nextGeneration, updatedAt: now })
            .where(eq(authCanonicalHeads.engine, engine));
        } else {
          await tx
            .insert(authCanonicalHeads)
            .values({ engine, payloadId, generation: nextGeneration, updatedAt: now });
        }
      }

      await persistEntries(tx, payloadId, entriesToStore, now);
      if (promotesCanonical && input.sourceHostId !== null) {
        await recordHostCanonical(
          tx,
          input.sourceHostId,
          payloadId,
          digestToStore,
          finalLastRefresh,
          engine,
          now,
        );
      }
      await writeStoreLog(
        tx,
        input,
        promotesCanonical ? 'updated' : 'outdated',
        digestToStore,
        now,
        runnerApplied,
        runnerSkippedReason,
        promotesCanonical ? 'accepted' : undefined,
      );
    });

    const result: StoreAuthCandidateResult = {
      status: promotesCanonical ? 'updated' : 'outdated',
      ...(promotesCanonical ? { auth: canonicalToStore } : {}),
      canonical_last_refresh: finalLastRefresh,
      canonical_digest: digestToStore,
      verification_state: verificationState,
      pending_payload_id: payloadId,
      runner_applied: runnerApplied,
      canonical_generation: nextGeneration,
      ...(promotesCanonical ? { candidate_result: 'accepted' as const } : {}),
      ...(runnerSkippedReason ? { runner_skipped_reason: runnerSkippedReason } : {}),
      engine,
    };
    if (postPersistError) throw postPersistError;
    return result;
  }

  async function returnExisting(
    input: StoreAuthCandidateInput,
    payloadId: number,
    rawState: string,
    canonical: { auth: Record<string, unknown>; digest: string; last_refresh: string },
    status: 'valid' | 'outdated',
    options: {
      generation?: number;
      candidateResult?: StoreAuthCandidateResult['candidate_result'];
      definitive?: boolean;
    } = {},
  ): Promise<StoreAuthCandidateResult> {
    const now = nowIso();
    const verificationState = normalizeVerificationState(rawState);
    const rows = await db.select().from(authPayloads).where(eq(authPayloads.id, payloadId));
    const storedRow = rows[0];
    const safeAuth =
      verificationState === 'verified' && storedRow
        ? runnerValidation.canonicalAuthFromPayload(storedRow as CanonicalPayloadRow)
        : null;
    const distributable = safeAuth !== null;
    const responseVerificationState =
      verificationState === 'verified' && !distributable ? 'unknown' : verificationState;
    const responseStatus = distributable ? status : 'outdated';
    const responseCandidateResult = distributable ? options.candidateResult : undefined;
    const generation = options.generation ?? storedRow?.generation ?? undefined;
    await db.transaction(async (tx) => {
      if (distributable && input.sourceHostId !== null) {
        await recordHostCanonical(
          tx,
          input.sourceHostId,
          payloadId,
          canonical.digest,
          canonical.last_refresh,
          input.engine,
          now,
        );
      }
      await writeStoreLog(
        tx,
        input,
        responseStatus,
        canonical.digest,
        now,
        false,
        undefined,
        responseCandidateResult,
      );
    });
    return {
      status: responseStatus,
      ...(distributable ? { auth: safeAuth } : {}),
      canonical_last_refresh: canonical.last_refresh,
      canonical_digest: canonical.digest,
      verification_state: responseVerificationState,
      pending_payload_id: payloadId,
      runner_applied: false,
      engine: input.engine,
      ...(generation !== undefined ? { canonical_generation: generation } : {}),
      ...(responseCandidateResult ? { candidate_result: responseCandidateResult } : {}),
      ...(options.definitive && distributable ? { candidate_rejected_definitive: true } : {}),
    };
  }

  async function withEngineStoreLock<T>(engine: Engine, fn: () => Promise<T>): Promise<T> {
    const previous = engineStoreTails.get(engine) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    engineStoreTails.set(engine, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (engineStoreTails.get(engine) === tail) engineStoreTails.delete(engine);
    }
  }

  async function recordHostCanonical(
    tx: DbLike,
    hostId: number,
    payloadId: number,
    digest: string,
    lastRefresh: string,
    engine: Engine,
    now: string,
  ): Promise<void> {
    await tx
      .insert(hostAuthDigests)
      .values({ hostId, digest, lastSeen: now, createdAt: now, engine })
      .onDuplicateKeyUpdate({ set: { lastSeen: now } });
    await touchHostAuthState(tx, hostId, payloadId, digest, engine);
    await touchHostAuthFields(tx, hostId, lastRefresh, digest, engine);
  }

  async function writeStoreLog(
    tx: DbLike,
    input: StoreAuthCandidateInput,
    status: StoreAuthCandidateResult['status'],
    digest: string,
    now: string,
    runnerApplied: boolean,
    runnerSkippedReason?: string,
    candidateResult?: StoreAuthCandidateResult['candidate_result'],
  ): Promise<void> {
    await tx.insert(logsTable).values({
      hostId: input.sourceHostId,
      action: input.logAction,
      details: JSON.stringify({
        status,
        engine: input.engine,
        digest,
        runner_applied: runnerApplied,
        source_kind: input.sourceKind ?? (input.sourceHostId === null ? 'legacy' : 'host'),
        ...(input.baseCanonicalGeneration !== undefined && input.baseCanonicalGeneration !== null
          ? { base_canonical_generation: input.baseCanonicalGeneration }
          : {}),
        ...(candidateResult ? { candidate_result: candidateResult } : {}),
        ...(runnerSkippedReason ? { runner_skipped_reason: runnerSkippedReason } : {}),
        ...(input.logDetails ?? {}),
      }),
      createdAt: now,
    });
  }

  // ensureServedVerification proves the canonical auth a host is about to launch
  // with actually works, bounded by a TTL so the common path stays probe-free.
  // This is the launch-gate counterpart to storeCandidate's upload-gate verify:
  // uploads are checked before acceptance, retrieves before being reported green.
  function servedVerificationSnapshot(input: EnsureServedVerificationInput): EnsureServedVerificationResult {
    const { row, auth, digest, lastRefresh } = input;
    const unchanged: EnsureServedVerificationResult = {
      state: 'unknown',
      auth,
      digest,
      lastRefresh,
      refreshed: false,
    };

    if (row.verificationState === 'failed') {
      return {
        ...unchanged,
        state: 'failed',
        reason: row.verificationReason ?? 'runner verification failed',
      };
    }
    if (row.verificationState === 'verified') return { ...unchanged, state: 'verified' };
    return unchanged;
  }

  async function ensureServedVerification(
    input: EnsureServedVerificationInput,
  ): Promise<EnsureServedVerificationResult> {
    const {
      engine,
      hostId,
      row,
      auth,
      digest,
      lastRefresh,
      ttlSeconds,
      forceLive = false,
      reissueCanonical = false,
    } = input;
    const unchanged: EnsureServedVerificationResult = {
      state: 'unknown',
      auth,
      digest,
      lastRefresh,
      refreshed: false,
    };

    // Without a runner we cannot prove the token works; preserve legacy
    // behaviour and report 'unknown' so the gate neither blocks nor falsely
    // claims verification.
    if (!runner.isConfigured()) return unchanged;

    // Trust a recent verdict: within the TTL a previously-verified payload is
    // served as-is, keeping the common launch path probe-free.
    const checkedMs = row.verificationCheckedAt ? Date.parse(row.verificationCheckedAt) : NaN;
    const withinTtl = Number.isFinite(checkedMs) && Date.now() - checkedMs <= Math.max(0, ttlSeconds) * 1000;
    if (!forceLive && row.verificationState === 'verified' && withinTtl) {
      return { ...unchanged, state: 'verified' };
    }
    if (!forceLive && row.verificationState === 'failed' && withinTtl) {
      return {
        ...unchanged,
        state: 'failed',
        reason: row.verificationReason ?? 'runner verification failed',
      };
    }

    // Past the probe-free fast paths: dedupe concurrent live probes for this
    // exact canonical row (see verificationInflight).
    const inflightKey = `${engine}:${row.id}`;
    const pending = verificationInflight.get(inflightKey);
    if (pending) return pending;

    const probe = withEngineStoreLock(engine, async (): Promise<EnsureServedVerificationResult> => {
      // The queue may have waited behind an upload. Never probe or rotate the
      // stale row supplied by the worker after another store became canonical.
      const selectedRow = await runnerValidation.resolveCanonicalPayload(engine);
      const selected = runnerValidation.validateCanonicalPayload(selectedRow);
      const retryingQuarantine = row.verificationState === 'pending' && selectedRow?.id !== row.id;
      if (retryingQuarantine) {
        const queuedRows = await db.select().from(authPayloads).where(eq(authPayloads.id, row.id));
        const queued = queuedRows[0];
        if (
          !queued ||
          queued.verificationState !== 'pending' ||
          queued.sha256 !== digest ||
          queued.engine !== engine
        ) {
          if (!selectedRow || !selected) return unchanged;
          const snapshot = servedVerificationSnapshot({
            ...input,
            row: selectedRow,
            auth: selected.auth,
            digest: selected.digest,
            lastRefresh: selected.last_refresh,
          });
          return { ...snapshot, refreshed: false };
        }
      } else if (selectedRow && selected && selected.digest !== digest) {
        const snapshot = servedVerificationSnapshot({
          ...input,
          row: selectedRow,
          auth: selected.auth,
          digest: selected.digest,
          lastRefresh: selected.last_refresh,
        });
        return { ...snapshot, refreshed: false };
      }

      // A Claude OAuth credential past its access-token lifetime is not
      // live-verifiable without spending the refresh token (see the candidate
      // gate in storeCandidateLocked). Keep the row's stored verdict: verified
      // lineage stays served — the hosts hold the refresh token and heal it
      // natively — while pending/failed rows wait for a superseding upload.
      if (claudeUnverifiableWithoutRefreshSpend(engine, inspectCredential(auth, engine))) {
        return { ...servedVerificationSnapshot(input), refreshed: false };
      }

      const verdict =
        engine === ENGINE_CLAUDE
          ? await runner.verifyClaude({ authJson: auth })
          : await runner.verify({ authJson: auth });

      const now = nowIso();
      const readbackFailure = runnerReadbackFailure(verdict);
      const refreshed = prepareRunnerUpdatedAuth(
        verdict.updated_auth,
        auth,
        lastRefresh,
        engine,
        runnerValidation,
      );
      let unsafeReason: string | null = readbackFailure
        ? `runner credential readback failed: ${readbackFailure}`
        : null;
      if (!unsafeReason && verdict.updated_auth !== undefined && !refreshed.ok) {
        unsafeReason = `runner refreshed auth but returned unusable credentials: ${
          refreshed.reason ?? 'updated_auth_invalid'
        }`;
      }
      if (!verdict.ok && verdict.definitive === true && unsafeReason) {
        // An explicit provider rejection can make the native CLI clear its
        // temporary file. Mark the selected head failed with the real reason;
        // an empty/unreadable file is not a rotated credential generation.
        const reason = (verdict.reason ?? 'runner verification failed').slice(0, 500);
        await markPayloadFailed(db, row.id, now, reason);
        return { ...unchanged, state: 'failed', reason };
      }
      if (unsafeReason) {
        const reason = unsafeReason;
        await markPayloadFailed(db, row.id, now, reason);
        return { ...unchanged, state: 'failed', reason };
      }

      // A changed readback from a non-OK probe is useful forensic history, but
      // it is not canonical proof. Quarantine it and fail the old head so no
      // host receives either unverified credential set.
      if (!verdict.ok && refreshed.ok && refreshed.digest !== digest) {
        const definitive = verdict.definitive === true;
        const failureReason = definitive
          ? `runner refreshed credentials then definitively rejected them${
              verdict.reason ? `: ${verdict.reason}` : ''
            }`.slice(0, 500)
          : undefined;
        try {
          await storeCandidateLocked({
            auth: verdict.updated_auth as Record<string, unknown>,
            engine,
            sourceHostId: hostId,
            requireLastRefresh: false,
            logAction: definitive ? 'auth.reverify_refresh_failed' : 'auth.reverify_refresh_pending',
            runnerPending: !definitive,
            runnerFailed: definitive,
            runnerFailureReason: failureReason,
            expectedCanonicalDigest: retryingQuarantine ? selected?.digest : digest,
            sourceKind: 'runner',
          });
          const reason = (
            failureReason ??
            `runner changed credentials but the final live probe was inconclusive${
              verdict.reason ? `: ${verdict.reason}` : ''
            }`
          ).slice(0, 500);
          await markPayloadFailed(db, row.id, now, reason);
          return { ...unchanged, state: 'failed', reason };
        } catch {
          const reason = definitive
            ? 'runner refreshed auth before definitive rejection but failed replacement persistence'
            : 'runner refreshed auth after an inconclusive probe but canonical persistence failed';
          await markPayloadFailed(db, row.id, now, reason);
          return { ...unchanged, state: 'failed', reason };
        }
      }

      // Runner outage (transport failure): do NOT downgrade the payload. Report
      // 'unknown' so the gate falls back to its offline/cached-credentials logic
      // instead of refusing launch during an infrastructure blip.
      if (!verdict.reachable) return unchanged;
      // A reachable-but-inconclusive protocol/runner failure without changed
      // credential bytes is not evidence that the known-good head is bad.
      if (!verdict.ok && !verdict.definitive) return unchanged;
      if (!verdict.ok) {
        await db
          .update(authPayloads)
          .set({
            verificationState: 'failed',
            verificationCheckedAt: now,
            verificationReason: (verdict.reason ?? 'runner verification failed').slice(0, 500),
          })
          .where(eq(authPayloads.id, row.id));
        return { ...unchanged, state: 'failed', reason: verdict.reason };
      }

      // Verified. If the runner refreshed the token, persist the refreshed blob
      // as a fresh canonical so the host receives live credentials rather than a
      // possibly-rotated pre-refresh refreshToken (reuses the tested store gate).
      if (refreshed.ok && refreshed.digest !== digest) {
        try {
          const stored = await storeCandidateLocked({
            auth: verdict.updated_auth as Record<string, unknown>,
            engine,
            sourceHostId: hostId,
            requireLastRefresh: false,
            logAction: 'auth.reverify_refresh',
            runnerVerified: true,
            expectedCanonicalDigest: retryingQuarantine ? selected?.digest : digest,
            sourceKind: 'runner',
          });
          if (stored.verification_state !== 'verified' || !stored.auth) {
            throw new ServiceUnavailableError(
              'Runner-refreshed credentials were not promoted as verified',
              'runner_updated_auth_invalid',
            );
          }
          if (retryingQuarantine) {
            await markPayloadFailed(
              db,
              row.id,
              now,
              'runner refreshed credential; verified replacement promoted',
            );
          }
          return {
            state: 'verified',
            auth: stored.auth,
            digest: stored.canonical_digest,
            lastRefresh: stored.canonical_last_refresh,
            refreshed: true,
          };
        } catch {
          // The runner changed the credential lineage. If that writeback
          // cannot be made canonical, the pre-refresh blob must not be stamped
          // verified and served as though the rotation never happened.
          const reason = 'runner refreshed auth but canonical persistence failed';
          await db
            .update(authPayloads)
            .set({ verificationState: 'failed', verificationCheckedAt: now, verificationReason: reason })
            .where(eq(authPayloads.id, row.id));
          return { ...unchanged, state: 'failed', reason };
        }
      }

      // Legacy rows may have been verified before canonical output matched the
      // native Codex auth-mode selector. The worker probes the normalized bytes
      // and must persist those exact bytes as a fresh verified generation; it
      // must never merely restamp the old conflicting/raw shape as verified.
      const probedDigest = runnerValidation.calculateDigest(JSON.stringify(auth));
      if (probedDigest !== digest || reissueCanonical) {
        try {
          const stored = await storeCandidateLocked({
            auth,
            engine,
            sourceHostId: hostId,
            requireLastRefresh: false,
            logAction: probedDigest !== digest ? 'auth.reverify_normalize' : 'auth.reverify_reissue',
            runnerVerified: true,
            expectedCanonicalDigest: retryingQuarantine ? selected?.digest : digest,
            sourceKind: 'runner',
          });
          if (stored.verification_state !== 'verified' || !stored.auth) {
            throw new ServiceUnavailableError(
              'Runner-verified normalized credentials were not promoted',
              'runner_updated_auth_invalid',
            );
          }
          if (retryingQuarantine) {
            await markPayloadFailed(
              db,
              row.id,
              now,
              'runner verified normalized credential; replacement promoted',
            );
          }
          return {
            state: 'verified',
            auth: stored.auth,
            digest: stored.canonical_digest,
            lastRefresh: stored.canonical_last_refresh,
            refreshed: true,
          };
        } catch {
          const reason = 'runner verified normalized auth but canonical persistence failed';
          await markPayloadFailed(db, row.id, now, reason);
          return { ...unchanged, state: 'failed', reason };
        }
      }

      if (retryingQuarantine) {
        const promoted = await promotePendingQuarantine(row.id, engine, selectedRow, now);
        if (!promoted) {
          const currentRow = await runnerValidation.resolveCanonicalPayload(engine);
          const current = runnerValidation.validateCanonicalPayload(currentRow);
          if (!currentRow || !current) return unchanged;
          const snapshot = servedVerificationSnapshot({
            ...input,
            row: currentRow,
            auth: current.auth,
            digest: current.digest,
            lastRefresh: current.last_refresh,
          });
          return { ...snapshot, refreshed: false };
        }
      } else {
        await db
          .update(authPayloads)
          .set({ verificationState: 'verified', verificationCheckedAt: now, verificationReason: null })
          .where(eq(authPayloads.id, row.id));
      }
      return { ...unchanged, state: 'verified' };
    });

    verificationInflight.set(inflightKey, probe);
    try {
      return await probe;
    } finally {
      verificationInflight.delete(inflightKey);
    }
  }

  async function promotePendingQuarantine(
    payloadId: number,
    engine: Engine,
    expectedHead: Awaited<ReturnType<RunnerValidationService['resolveCanonicalPayload']>>,
    now: string,
  ): Promise<boolean> {
    let promoted = false;
    await db.transaction(async (tx) => {
      const pendingRows = await tx.select().from(authPayloads).where(eq(authPayloads.id, payloadId));
      const pending = pendingRows[0];
      if (!pending || pending.engine !== engine || pending.verificationState !== 'pending') return;

      const heads = await tx.select().from(authCanonicalHeads).where(eq(authCanonicalHeads.engine, engine));
      const head = heads[0];
      if (
        head &&
        (!expectedHead ||
          head.payloadId !== expectedHead.id ||
          head.generation !== (expectedHead.generation ?? head.generation))
      ) {
        return;
      }

      if (expectedHead && expectedHead.id !== payloadId) {
        await tx
          .update(authPayloads)
          .set({ supersededAt: now, purgeAfter: retentionDeadline(now) })
          .where(eq(authPayloads.id, expectedHead.id));
      }
      await tx
        .update(authPayloads)
        .set({
          verificationState: 'verified',
          verificationCheckedAt: now,
          verificationReason: null,
          supersededAt: null,
          purgeAfter: null,
        })
        .where(eq(authPayloads.id, payloadId));

      const generation = pending.generation ?? Math.max(expectedHead?.generation ?? 0, 0) + 1;
      if (head) {
        await tx
          .update(authCanonicalHeads)
          .set({ payloadId, generation, updatedAt: now })
          .where(eq(authCanonicalHeads.engine, engine));
      } else {
        await tx.insert(authCanonicalHeads).values({ engine, payloadId, generation, updatedAt: now });
      }
      promoted = true;
    });
    return promoted;
  }

  return { storeCandidate, servedVerificationSnapshot, ensureServedVerification };
}

export async function touchHostAuthFields(
  db: DbLike,
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
  db: DbLike,
  hostId: number,
  payloadId: number,
  digest: string,
  engine: Engine,
): Promise<void> {
  const now = nowIso();
  await db
    .insert(hostAuthStates)
    .values({ hostId, payloadId, seenDigest: digest, seenAt: now, engine })
    .onDuplicateKeyUpdate({ set: { payloadId, seenDigest: digest, seenAt: now } });
}

export function assertReasonableLastRefresh(value: string, field: string): void {
  if (!isRfc3339(value)) throw new ValidationError(`${field} must be an RFC3339 timestamp`, { param: field });
  const ts = parseRfc3339Millis(value);
  if (ts === null) throw new ValidationError(`${field} must be an RFC3339 timestamp`, { param: field });
  if (ts < MIN_REFRESH_EPOCH_MS) throw new ValidationError(`${field} is implausibly old`, { param: field });
  if (ts > Date.now() + MAX_FUTURE_SKEW_MS)
    throw new ValidationError(`${field} is in the future`, { param: field });
}

function prepareRunnerUpdatedAuth(
  updatedAuth: unknown,
  sourceAuth: Record<string, unknown>,
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
  const returned = { ...(updatedAuth as Record<string, unknown>) };
  const sourceIdentity = inspectCredential(sourceAuth, engine);
  const updatedIdentity = inspectCredential(returned, engine);
  if (!sourceIdentity) return { ok: false, reason: 'updated_auth_source_credential_uninspectable' };
  if (!updatedIdentity) return { ok: false, reason: 'updated_auth_no_inspectable_credential' };
  if (updatedIdentity.kind !== sourceIdentity.kind) {
    return { ok: false, reason: 'updated_auth_credential_kind_changed' };
  }
  if (sourceIdentity.refresh && !updatedIdentity.refresh) {
    return { ok: false, reason: 'updated_auth_refresh_token_lost' };
  }
  const updated = projectNativeOauthBearer(returned, updatedIdentity, engine);
  // Codex and Claude own their native credential files and may rewrite them
  // without our wrapper-only generation field. The runner just observed that
  // rewrite during this verified probe, so inherit the upload generation
  // instead of discarding the refreshed token.
  const rawUpdatedLast = typeof updated.last_refresh === 'string' ? updated.last_refresh.trim() : '';
  const updatedLast = rawUpdatedLast || uploadLastRefresh;
  try {
    assertReasonableLastRefresh(updatedLast, 'updated_auth.last_refresh');
  } catch {
    return { ok: false, reason: 'updated_auth_invalid_last_refresh' };
  }
  updated.last_refresh = normalizeLastRefresh(updatedLast);
  if (compareCanonicalStamps(updatedLast, uploadLastRefresh) < 0) {
    return { ok: false, reason: 'updated_auth_older_than_upload' };
  }
  const withFallback = runnerValidation.ensureAuthsFallback(updated, engine);
  const entries = runnerValidation.normalizeAuthEntries(withFallback, engine);
  if (!runnerValidation.hasUsableEngineCredential(withFallback, engine)) {
    return { ok: false, reason: 'updated_auth_no_usable_tokens' };
  }
  const canonical = runnerValidation.canonicalizeAuthPayload(
    withFallback,
    entries,
    normalizeLastRefresh(updatedLast),
    engine,
  );
  const encoded = JSON.stringify(canonical);
  return {
    ok: true,
    canonical,
    encoded,
    digest: runnerValidation.calculateDigest(encoded),
    entries,
  };
}

function projectNativeOauthBearer(
  auth: Record<string, unknown>,
  identity: NonNullable<ReturnType<typeof inspectCredential>>,
  engine: Engine,
): Record<string, unknown> {
  if (identity.kind === 'api_key') return auth;
  const target = engine === ENGINE_CLAUDE ? 'api.anthropic.com' : 'api.openai.com';
  const rawAuths = isObjectRecord(auth.auths) ? auth.auths : {};
  const rawNativeEntry = isObjectRecord(rawAuths[target]) ? rawAuths[target] : {};
  return {
    ...auth,
    auths: {
      ...rawAuths,
      [target]: {
        ...rawNativeEntry,
        token: identity.access,
        token_type:
          typeof rawNativeEntry.token_type === 'string' && rawNativeEntry.token_type.trim()
            ? rawNativeEntry.token_type
            : 'bearer',
      },
    },
  };
}

// The one Claude OAuth shape a live probe can only check by consuming refresh
// material: access token expired (or about to), refresh token present and
// unexpired. Anything else either probes cleanly on its access token or is
// dead outright and may fail definitively.
function claudeUnverifiableWithoutRefreshSpend(
  engine: Engine,
  identity: ReturnType<typeof inspectCredential>,
): boolean {
  return (
    engine === ENGINE_CLAUDE &&
    identity !== null &&
    identity.kind === 'claude_oauth' &&
    identity.refresh !== '' &&
    accessCredentialExpired(identity, Date.now() + CLAUDE_ACCESS_PROBE_MARGIN_MS) &&
    !refreshCredentialExpired(identity)
  );
}

function sharesConsumableCredentialLineage(
  candidate: NonNullable<ReturnType<typeof inspectCredential>>,
  selected: NonNullable<ReturnType<typeof inspectCredential>>,
): boolean {
  if (candidate.kind !== selected.kind) return false;
  if (candidate.kind === 'api_key') return candidate.access === selected.access;
  return (
    candidate.access === selected.access ||
    (candidate.refresh !== '' && selected.refresh !== '' && candidate.refresh === selected.refresh)
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runnerReadbackFailure(verdict: Awaited<ReturnType<RunnerClient['verify']>>): string | null {
  if (verdict.auth_readback === 'error') {
    return typeof verdict.auth_readback_error === 'string' && verdict.auth_readback_error.trim()
      ? verdict.auth_readback_error.trim()
      : 'post-probe credential file unreadable';
  }
  if (verdict.auth_readback === 'updated' && verdict.updated_auth === undefined) {
    return 'runner reported changed credentials without replacement bytes';
  }
  return null;
}

async function markPayloadFailed(
  db: Database,
  payloadId: number,
  checkedAt: string,
  reason: string,
): Promise<void> {
  await db
    .update(authPayloads)
    .set({
      verificationState: 'failed',
      verificationCheckedAt: checkedAt,
      verificationReason: reason.slice(0, 500),
    })
    .where(eq(authPayloads.id, payloadId));
}

function normalizeVerificationState(value: string): 'pending' | 'verified' | 'failed' {
  return value === 'verified' || value === 'failed' ? value : 'pending';
}

function normalizeLastRefresh(value: string): string {
  const normalized = normalizeRfc3339Nanos(value);
  if (!normalized)
    throw new ValidationError('last_refresh must be an RFC3339 timestamp', { param: 'last_refresh' });
  return normalized;
}

function nextCanonicalStamp(current: string, reflectRotationTime = false): string {
  const currentNanos = parseRfc3339Nanos(current);
  if (currentNanos === null) {
    throw new ServiceUnavailableError('Canonical auth timestamp is invalid', 'canonical_timestamp_exhausted');
  }
  const nowNanos = BigInt(Date.now()) * 1_000_000n;
  const nextNanos = reflectRotationTime && nowNanos > currentNanos ? nowNanos : currentNanos + 1_000_000n;
  if (nextNanos > nowNanos + BigInt(MAX_FUTURE_SKEW_MS) * 1_000_000n) {
    throw new ServiceUnavailableError(
      'Canonical auth timestamp cannot advance within the accepted future-skew bound',
      'canonical_timestamp_exhausted',
    );
  }
  return formatRfc3339Nanos(nextNanos);
}

function compareCanonicalStamps(a: string, b: string): number {
  const compared = compareRfc3339(a, b);
  if (compared === null) {
    throw new ServiceUnavailableError('Canonical auth timestamp is invalid', 'canonical_timestamp_exhausted');
  }
  return compared;
}
