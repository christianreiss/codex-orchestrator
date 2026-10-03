import { randomBytes } from 'node:crypto';
import type { Engine } from '../util/engine.js';
import { ServiceUnavailableError } from '../http/errors.js';
import type { ProviderAccountsService } from './provider-accounts.js';
import type { RunnerValidationService } from './runner-validation.js';
import { SettingsService } from './settings.js';
import type { Database } from '../db/client.js';
import { assertFleetEngineEnabledForAdmin } from './engine-switch.js';

/** Reserve and release internal runner work using the same selection policy. */
export async function withAccountTask<T>(
  accounts: ProviderAccountsService | undefined,
  db: Database | undefined,
  validation: RunnerValidationService,
  engine: Engine,
  fallback: () => Promise<Record<string, unknown>>,
  run: (auth: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  // Internal runner work (AI assist drafts) spends the engine's subscription
  // just like a host would; a fleet-disabled engine does none of it.
  if (db) await assertFleetEngineEnabledForAdmin(db, engine);
  if (!accounts) return run(await fallback());
  const id = randomBytes(16).toString('hex');
  const settings = db ? new SettingsService(db) : null;
  const threshold = settings ? await settings.getInt('quota_limit_percent', 100) : 100;
  const lease = await accounts.acquire(0, engine, id, id, Math.max(50, Math.min(100, threshold)));
  const timer = setInterval(() => {
    void accounts.heartbeat(0, engine, id).catch(() => {});
  }, 30_000);
  timer.unref();
  try {
    const row = await validation.resolveCanonicalPayload(engine, lease.account.id);
    const auth = row ? validation.canonicalAuthFromPayload(row) : null;
    if (!auth)
      throw new ServiceUnavailableError('Selected provider account is unavailable', 'account_unavailable');
    return await run(auth);
  } finally {
    clearInterval(timer);
    await accounts.release(0, engine, id);
  }
}
