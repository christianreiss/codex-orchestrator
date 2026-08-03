import { createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../env.js';
import { createDb } from '../db/client.js';
import { wrapperSigningKeys } from '../db/schema.js';
import { Keyring } from '../security/keyring.js';
import { decrypt, encrypt, isEnvelope } from '../security/secret-box.js';
import { createWrapperSigningKeyService, publicKeyB64 } from '../services/wrapper-signing-key.js';
import { nowIso } from '../util/timestamp.js';

/** `publicKeyB64` for a row whose stored material may be unparseable. */
function publicKeyB64OrNull(material: string): string | null {
  try {
    return publicKeyB64(material);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const privatePath = process.argv[2];
  const publicPath = process.argv[3];
  if (!privatePath || !publicPath) {
    throw new Error('usage: node setup-signing-key.js PRIVATE_KEY PUBLIC_KEY');
  }

  const env = loadEnv();
  const { db, pool } = createDb(env);
  const keyring = Keyring.fromEnv(env);
  try {
    const [privatePem, publicPem] = await Promise.all([
      readFile(privatePath, 'utf8'),
      readFile(publicPath, 'utf8'),
    ]);
    const expected = publicKeyB64(publicPem);
    if (publicKeyB64(privatePem) !== expected) throw new Error('private/public signing key mismatch');

    const keyId = await db.transaction(async (tx) => {
      const active = await tx
        .select()
        .from(wrapperSigningKeys)
        .where(eq(wrapperSigningKeys.active, 1))
        .for('update');
      // Several keys may be active at once (rotation is additive), so setup
      // adopts the row matching THIS installation's key rather than assuming
      // there is only one. Setup is not the rotation entry point: an active set
      // that does not contain this key is still refused, and never appended to.
      const row = active.find((candidate) => publicKeyB64OrNull(candidate.publicKey) === expected);
      if (row) {
        if (!row.privateKeyEnc || !isEnvelope(row.privateKeyEnc)) {
          throw new Error('active signing key is not encrypted; repair it explicitly before rerunning setup');
        }
        const readBack = decrypt(row.privateKeyEnc, keyring);
        if (publicKeyB64(readBack) !== expected) throw new Error('encrypted signing-key read-back mismatch');
        return row.id;
      }
      if (active.length > 0) {
        throw new Error('active database signing key does not match this installation; automatic rotation is refused');
      }

      const result = await tx.insert(wrapperSigningKeys).values({
        algo: 'ed25519',
        publicKey: publicPem.trim() + '\n',
        privateKeyEnc: encrypt(privatePem, keyring),
        active: 1,
        createdAt: nowIso(),
        rotatedAt: null,
      });
      const insertedId = Number(result[0]?.insertId ?? 0);
      if (!insertedId) throw new Error('database did not return the imported signing-key id');
      return insertedId;
    });

    const signerService = createWrapperSigningKeyService({ db, keyring });
    // The imported key need not be the primary (oldest) one when a rotation is
    // in flight, so the read-back looks it up by id instead of assuming `[0]`.
    const signers = await signerService.allActive();
    const signer = signers.find((candidate) => candidate.kid === String(keyId));
    if (!signer || signer.publicKey !== expected) {
      throw new Error('active signer read-back did not match the imported key');
    }
    const payload = randomBytes(48);
    const signature = signer.sign(payload);
    if (!cryptoVerify(null, payload, createPublicKey(publicPem), signature)) {
      throw new Error('active signer failed its signature round-trip');
    }
    process.stdout.write(JSON.stringify({ ok: true, key_id: keyId, public_key: expected }) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
