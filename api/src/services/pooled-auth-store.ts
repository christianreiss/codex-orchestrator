import {
  createCanonicalAuthStoreService,
  type CanonicalAuthStoreDeps,
  type CanonicalAuthStoreService,
} from './canonical-auth-store.js';
import { wsPublisher } from '../ws/publisher.js';
import { ProviderAccountsService } from './provider-accounts.js';

/** All production upload surfaces share account discovery and retirement rules. */
export function createPooledAuthStoreService(deps: CanonicalAuthStoreDeps): CanonicalAuthStoreService {
  const base = createCanonicalAuthStoreService(deps);
  const accounts = new ProviderAccountsService(deps.db, deps.keyring);
  return {
    ...base,
    async storeCandidate(input) {
      const account = await accounts.resolveCandidate(
        input.auth,
        input.engine,
        input.accountId,
        input.sourceHostId,
        input.accountHint === true,
      );
      const result = await base.storeCandidate({ ...input, accountId: account.id });
      wsPublisher.publish('accounts.updated', { account_id: account.id });
      return result;
    },
  };
}
