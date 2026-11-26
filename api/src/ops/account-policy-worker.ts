import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { startOwnerWorker } from './owner-worker.js';
import { dependencyRevision } from './schedule-obligations.js';
import { AccountSwitchService, LIVE_SWITCH_ENGINES } from '../services/account-switch.js';

const EVALUATE_EVERY_MS = 60_000;

/**
 * Applies the automatic account distribution policy to running scopes. Usage
 * reports trigger an immediate pass; this worker covers dwell expiry, policy
 * changes and accounts that stop being usable.
 */
export function startAccountPolicyWorker(app: FastifyInstance, db: Database, keyring: Keyring): void {
  const switches = new AccountSwitchService(db, keyring);
  const tables = ['versions', 'providerAccounts', 'providerAccountSessions', 'claudeUsageSnapshots'] as const;
  startOwnerWorker(app, db, {
    name: 'account-policy',
    tables,
    select(snapshot, now) {
      const live = snapshot
        .table('providerAccountSessions')
        .all()
        .some((r) => LIVE_SWITCH_ENGINES.has(r.engine as never) && r.hostId > 0 && (r.ownershipMode === 'connection' || Date.parse(r.expiresAt) > now));
      return live ? [{ key: 'account-policy', revision: dependencyRevision(snapshot, tables), dueAt: 0 }] : [];
    },
    async run() {
      for (const engine of LIVE_SWITCH_ENGINES) await switches.evaluate(engine);
      return { retryAt: Date.now() + EVALUATE_EVERY_MS };
    },
    error: (error) => app.log.warn({ err: error }, 'account policy evaluation failed'),
  });
}
