import { createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../env.js';
import { createDb } from '../db/client.js';
import { wrapperSigningKeys } from '../db/schema.js';
import { Keyring } from '../security/keyring.js';
import { decrypt, encrypt, isEnvelope } from '../security/secret-box.js';
import { createWrapperSigningKeyService, toKeyObject } from '../services/wrapper-signing-key.js';
import { nowIso } from '../util/timestamp.js';

function publicKeyB64(material: string): string {
  const trimmed = material.trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) && Buffer.from(trimmed, 'base64').length === 32) {
    return trimmed;
  }
  const key = trimmed.includes('PRIVATE KEY') ? toKeyObject(trimmed) : null;
  const publicKey = key ? createPublicKey(key) : createPublicKey(trimmed);
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('signing material is not an Ed25519 key');
  return Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
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
      if (active.length > 1) {
        throw new Error('multiple active wrapper signing keys; deactivate the obsolete rows manually before rerunning setup');
      }

      if (active.length === 1) {
        const row = active[0]!;
        if (publicKeyB64(row.publicKey) !== expected) {
          throw new Error('active database signing key does not match this installation; automatic rotation is refused');
        }
        if (!row.privateKeyEnc || !isEnvelope(row.privateKeyEnc)) {
          throw new Error('active signing key is not encrypted; repair it explicitly before rerunning setup');
        }
        const readBack = decrypt(row.privateKeyEnc, keyring);
        if (publicKeyB64(readBack) !== expected) throw new Error('encrypted signing-key read-back mismatch');
        return row.id;
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
    const signer = await signerService.active();
    if (!signer || signer.kid !== String(keyId) || signer.publicKey !== expected) {
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
