import { makeAccountLock, type AccountOwner } from './provider-account-lock.js';

export type KimiAccountOwner = AccountOwner;

export const withKimiAccountLock = makeAccountLock({ engine: 'kimi', label: 'Kimi' });
