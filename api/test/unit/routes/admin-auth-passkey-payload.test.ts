import { describe, expect, it } from 'vitest';
import {
  normalizePasskeyAuthenticationBody,
  normalizePasskeyRegistrationBody,
} from '../../../src/routes/admin/auth/index.js';

const registrationCredential = {
  id: 'cred-id',
  rawId: 'raw-id',
  type: 'public-key',
  response: {
    clientDataJSON: 'client-json',
    attestationObject: 'attestation',
  },
};

const authenticationCredential = {
  id: 'cred-id',
  rawId: 'raw-id',
  type: 'public-key',
  response: {
    clientDataJSON: 'client-json',
    authenticatorData: 'auth-data',
    signature: 'sig',
  },
};

describe('passkey payload normalization', () => {
  it('wraps raw registration credentials for legacy clients', () => {
    expect(normalizePasskeyRegistrationBody(registrationCredential)).toEqual({
      response: registrationCredential,
      name: undefined,
    });
  });

  it('keeps wrapped registration credentials', () => {
    expect(normalizePasskeyRegistrationBody({ response: registrationCredential, name: 'Laptop' })).toEqual({
      response: registrationCredential,
      name: 'Laptop',
    });
  });

  it('wraps raw authentication credentials for legacy clients', () => {
    expect(normalizePasskeyAuthenticationBody(authenticationCredential)).toEqual({
      response: authenticationCredential,
    });
  });

  it('keeps wrapped authentication credentials', () => {
    expect(normalizePasskeyAuthenticationBody({ response: authenticationCredential })).toEqual({
      response: authenticationCredential,
    });
  });
});
