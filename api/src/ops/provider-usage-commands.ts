import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import { GrokUsageService } from '../services/grok-usage.js';
import { KimiUsageService } from '../services/kimi-usage.js';
import { ChatGptUsageService } from '../services/chatgpt-usage.js';
import { createGrokAuthOwner } from '../services/grok-auth-owner.js';
import { createKimiAuthOwner } from '../services/kimi-auth-owner.js';
import { createRunnerClient } from '../services/runner-client.js';
import type { OwnerWorkObligation, OwnerWorkResult } from './owner-worker.js';
/** Concrete provider operations invoked only by an indexed actual refresh deadline. */
export function createProviderUsageCommands(db: Database, env: Env, keyring: Keyring) {
  const grok = new GrokUsageService({
    db,
    authOwner: createGrokAuthOwner({ db, keyring, runner: createRunnerClient({ env }) }),
  });
  const kimi = new KimiUsageService({
    db,
    authOwner: createKimiAuthOwner({ db, keyring, runner: createRunnerClient({ env }) }),
  });
  return async (
    operation: 'grok-usage' | 'kimi-usage' | 'chatgpt-usage',
    obligation: OwnerWorkObligation,
  ): Promise<OwnerWorkResult> => {
    if (operation === 'grok-usage') await grok.refreshAccount(Number(obligation.key));
    else if (operation === 'kimi-usage') await kimi.refreshAccount(Number(obligation.key));
    else
      await new ChatGptUsageService(db, undefined, {
        env,
        keyring,
        ...(obligation.key === 'canonical' ? {} : { accountId: Number(obligation.key) }),
      }).fetchLatest();
    return { observed: true };
  };
}
