import { makeAccountLock, type AccountOwner } from './provider-account-lock.js';

export type GrokAccountOwner = AccountOwner;

export const withGrokAccountLock = makeAccountLock({ engine: 'grok', label: 'Grok' });
