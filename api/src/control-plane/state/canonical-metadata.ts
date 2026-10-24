import { createHash } from 'node:crypto';
import type { Keyring } from '../../security/keyring.js';
import type { Database } from '../../db/client.js';
import type { CanonicalPayloadRow } from '../../services/runner-validation.js';
import {
  createRunnerValidationService,
  compareCanonicalRowsNewestFirst,
} from '../../services/runner-validation.js';
import { parseRfc3339Millis } from '../../util/timestamp.js';
import type { Engine } from '../../util/engine.js';
import type { OwnerStateSnapshot } from './store.js';
export interface CanonicalBodyProof {
  sha256: string;
  lastRefresh: string;
  engine: string;
  bodyDigest: string;
}
/** Reuse the original validator; the timestamp's moving upper bound is checked
 * when selecting. Boot/insert never retains decrypted credentials in owned state. */
export function deriveCanonicalBodyProof(
  db: Pick<Database, 'select'>,
  row: CanonicalPayloadRow,
  keyring?: Keyring,
): CanonicalBodyProof | null {
  const instant = parseRfc3339Millis(row.lastRefresh),
    validator = createRunnerValidationService({ db, keyring });
  if (!validator.validateCanonicalPayload(row, Math.max(Date.now(), instant ?? 0)) || !row.body) return null;
  return {
    sha256: row.sha256,
    lastRefresh: row.lastRefresh,
    engine: row.engine,
    bodyDigest: createHash('sha256').update(row.body).digest('hex'),
  };
}
export function currentCanonicalMetadata(snapshot: OwnerStateSnapshot, engine: Engine, now = Date.now()) {
  const head = snapshot.table('authCanonicalHeads').get(engine);
  if (head) {
    const row = snapshot.table('authPayloads').get(head.payloadId);
    return row && (!row.accountId || snapshot.accounts.get(row.accountId)?.state === 'enabled') ? row : null;
  }
  return (
    snapshot
      .table('authPayloads')
      .by('engine', engine)
      .filter(
        (row) =>
          row.accountId === null &&
          row.verificationState === 'verified' &&
          row.canonicalBodyProof &&
          (parseRfc3339Millis(row.lastRefresh) ?? Infinity) <= now + 300000,
      )
      .toSorted((a, b) => compareCanonicalRowsNewestFirst({ ...a, body: null }, { ...b, body: null }))[0] ??
    null
  );
}
