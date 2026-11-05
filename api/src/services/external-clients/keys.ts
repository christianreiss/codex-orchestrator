import { randomBytes } from 'node:crypto';
import { sha256 } from '../../security/hash.js';

export const EXTERNAL_KEY_PREFIX = 'cxe_';

export interface ExternalKey {
  key: string;
  hash: string;
  prefix: string;
}

/** A fresh client key. Only the hash and a short display prefix are ever stored. */
export function newExternalKey(): ExternalKey {
  const key = EXTERNAL_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: sha256(key), prefix: key.slice(0, EXTERNAL_KEY_PREFIX.length + 6) };
}

export function hashExternalKey(key: string): string {
  return sha256(key);
}

/**
 * Stable in-process bridge token of the client's virtual session (43-128
 * base64url characters). Derived from the per-client secret, so it survives API
 * restarts and a key rotation, and never leaves the server.
 */
export function bridgeTokenFor(clientId: string, bridgeSecret: string): string {
  return Buffer.from(sha256(`external-bridge:${clientId}:${bridgeSecret}`), 'hex').toString('base64url');
}
