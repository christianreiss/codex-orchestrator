import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import type { StateSeed } from '../src/control-plane/state/catalog.js';
import {
  deriveCanonicalBodyProof,
  currentCanonicalMetadata,
} from '../src/control-plane/state/canonical-metadata.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../src/control-plane/state/store.js';
import { sha256 } from '../src/security/hash.js';
import {
  createRunnerValidationService,
  type CanonicalPayloadRow,
} from '../src/services/runner-validation.js';
const db = {
  select: vi.fn(() => {
    throw new Error('metadata SQL');
  }),
} as unknown as Database;
function payload(id: number, lastRefresh = '2026-01-01T00:00:00Z') {
  const body = JSON.stringify({
    last_refresh: lastRefresh,
    auths: { 'api.anthropic.com': { token: 'sk-ant-api03-' + 'x'.repeat(64) } },
  });
  const row: CanonicalPayloadRow = {
    id,
    accountId: null,
    engine: 'claude',
    body,
    sha256: sha256(body),
    lastRefresh,
    createdAt: lastRefresh,
    verificationState: 'verified',
    verificationCheckedAt: lastRefresh,
  };
  return { ...row, canonicalBodyProof: deriveCanonicalBodyProof(db, row) };
}
describe('owned legacy canonical metadata proof', () => {
  it('preserves verifier selection, timestamp offsets and future-skew boundary without reads', () => {
    const a = payload(1, '2026-01-01T10:30:00+02:00'),
      b = payload(2, '2026-01-01T09:00:00Z'),
      future = payload(3, '2098-01-01T00:00:00Z');
    expect(a.canonicalBodyProof).not.toBeNull();
    expect(createRunnerValidationService({ db }).validateCanonicalPayload(future)).toBeNull();
    const state = new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, {
      authPayloads: [a, b, future],
    } as unknown as StateSeed);
    expect(currentCanonicalMetadata(state, 'claude')?.id).toBe(2);
    expect(currentCanonicalMetadata(state, 'claude', Date.parse(future.lastRefresh) - 300000)?.id).toBe(3);
    expect(currentCanonicalMetadata(state, 'codex')).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });
  it('invalidates changed bytes/identity and recomputes eligibility after verification/account/removal changes', () => {
    const a = payload(1),
      b = payload(2, '2026-02-01T00:00:00Z'),
      epoch = randomUUID(),
      store = new OwnerStateStore(
        new OwnerStateSnapshot({ epoch, sequence: 0n }, { authPayloads: [a, b] } as unknown as StateSeed),
      );
    let draft = store.begin();
    draft.upsert('authPayloads', { ...draft.table('authPayloads').get(2)!, verificationState: 'failed' });
    store.publish(draft.seal({ epoch, sequence: 1n }));
    expect(currentCanonicalMetadata(store.snapshot(), 'claude')?.id).toBe(1);
    draft = store.begin();
    draft.upsert('authPayloads', {
      ...draft.table('authPayloads').get(2)!,
      verificationState: 'verified',
      body: 'changed',
    });
    store.publish(draft.seal({ epoch, sequence: 2n }));
    expect(currentCanonicalMetadata(store.snapshot(), 'claude')?.id).toBe(1);
    draft = store.begin();
    draft.remove('authPayloads', 1);
    store.publish(draft.seal({ epoch, sequence: 3n }));
    expect(currentCanonicalMetadata(store.snapshot(), 'claude')).toBeNull();
  });
});
