import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { createCanonicalAuthStoreService } from '../../../src/services/canonical-auth-store.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { withGrokAccountLock } from '../../../src/services/grok-auth-lock.js';

function fixture() {
  const seed = {
    providerAccounts: [
      {
        id: 1,
        engine: 'claude',
        label: 'fixture',
        state: 'enabled',
        payloadId: null,
        generation: 0,
        mergedIntoAccountId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  const db = createDbFake(new Map([[schema.providerAccounts, structuredClone(seed.providerAccounts)]]));
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(db, runtime);
  return { db: db as never, state, runtime, close: () => deadlines.close() };
}
const candidate = {
  last_refresh: '2026-05-20T09:00:00Z',
  auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-owner-a' } },
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-owner-a',
    refreshToken: 'owner-refresh-a',
    expiresAt: Date.now() + 86400000,
    refreshTokenExpiresAt: Date.now() + 86400000 * 30,
  },
};
describe('canonical credentials under one owner', () => {
  it('publishes verified generation, account and head atomically without retaining credential bytes', async () => {
    const h = fixture();
    try {
      const keyring = testKeyring();
      const runner = {
        isConfigured: () => true,
        verify: async () => ({ ok: true, status: 'ok' as const, reachable: true }),
        verifyClaude: async () => ({ ok: true, status: 'ok' as const, reachable: true }),
      };
      const store = createCanonicalAuthStoreService({
        db: h.db,
        keyring,
        runnerValidation: createRunnerValidationService({ db: h.db, keyring }),
        runner,
      });
      const result = await store.storeCandidate({
        accountId: 1,
        engine: 'claude',
        auth: candidate,
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'owner.test',
      });
      expect(result.status).toBe('updated');
      const snapshot = h.state.snapshot();
      const payload = snapshot.table('authPayloads').get(result.pending_payload_id)!;
      expect(payload.verificationState).toBe('verified');
      expect(payload).not.toHaveProperty('body');
      expect(snapshot.accounts.get(1)?.payloadId).toBe(payload.id);
      expect(snapshot.table('authCanonicalHeads').get('claude')?.payloadId).toBe(payload.id);
      const reread = await createRunnerValidationService({ db: h.db, keyring }).resolveCanonicalPayload(
        'claude',
        1,
      );
      expect(reread?.id).toBe(payload.id);
      expect(reread?.body).toBeTruthy();
      expect(
        (
          await store.storeCandidate({
            accountId: 1,
            engine: 'claude',
            auth: candidate,
            sourceHostId: null,
            requireLastRefresh: true,
            logAction: 'owner.test',
          })
        ).pending_payload_id,
      ).toBe(payload.id);
    } finally {
      h.close();
    }
  });
  it('does not let a timed-out waiter remove the live Grok refresh lock', async () => {
    const h = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let began = false;
    try {
      const first = withGrokAccountLock(h.db, 1, async () => {
        began = true;
        await held;
      });
      while (!began) await Promise.resolve();
      await expect(withGrokAccountLock(h.db, 1, async () => {}, Date.now() + 5)).rejects.toThrow('pending');
      let thirdEntered = false;
      const third = withGrokAccountLock(h.db, 1, async () => {
        thirdEntered = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(thirdEntered).toBe(false);
      release();
      await first;
      await third;
      expect(thirdEntered).toBe(true);
    } finally {
      release?.();
      h.close();
    }
  });
});
