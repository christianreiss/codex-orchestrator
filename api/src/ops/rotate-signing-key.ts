import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../env.js';
import { createDb } from '../db/client.js';
import { wrapperSigningKeys } from '../db/schema.js';
import { Keyring } from '../security/keyring.js';
import { encrypt } from '../security/secret-box.js';
import {
  createWrapperSigningKeyService,
  publicKeyB64,
  type WrapperSigner,
} from '../services/wrapper-signing-key.js';
import { nowIso } from '../util/timestamp.js';

/**
 * Wrapper signing-key rotation.
 *
 * `setup-signing-key.ts` imports THE key of an installation and deliberately
 * refuses to replace it. Rotation is the other half: several keys may be active
 * at once, every active key signs the baked config, and the oldest active key
 * stays primary — the one whose signature fills `signature`/`.sig` and which
 * the public key embedded in deployed binaries verifies.
 *
 * So a rotation is additive first and destructive last:
 *
 *   1. `add NEW_PRIVATE NEW_PUBLIC` — the new key starts co-signing
 *      immediately; nothing on any host changes yet. This is the only step
 *      that is reversible and zero-impact.
 *   2. build binaries embedding the new public key.
 *   3. `retire OLD_KEY_ID` — the old key stops signing and the newer key
 *      becomes primary — and roll the fleet onto those binaries, in ONE
 *      window.
 *
 * Steps 2 and 3 are coupled, not independently safe: a binary embeds one public
 * key and no shipped `cxx` reads the extra `signatures`, so while the old key is
 * primary a new-key binary rejects every config, and once it is retired an
 * old-key binary does. Reversing 1 and 3 is the worse outage: retiring first
 * leaves the WHOLE fleet verifying against a key the server no longer signs
 * with. The full runbook is in `docs/wrapper-v2-architecture.md`.
 *
 * `list` reads the database through its own service instance and therefore
 * cannot see the running API's cached signer set — confirm a rotation against
 * `GET /wrapper/v2/config`, never against this output alone.
 */

const USAGE = [
  'usage: node rotate-signing-key.js list',
  '       node rotate-signing-key.js add PRIVATE_KEY PUBLIC_KEY',
  '       node rotate-signing-key.js retire KEY_ID',
].join('\n');

/**
 * Printed to stderr (stdout stays machine-readable) after any command that
 * could otherwise be mistaken for proof that the running API picked a change up.
 */
const STALE_CACHE_NOTE = [
  'note: this reads the database directly and cannot see the running API\'s cached signer set.',
  '      confirm against the API itself:',
  '      curl -sH "X-API-Key: $HOST_KEY" "$BASE_URL/wrapper/v2/config?engine=codex" | jq -r ".signatures[].fingerprint"',
  '',
].join('\n');

function describe(signer: WrapperSigner): { kid: string; fingerprint: string; public_key: string } {
  return { kid: signer.kid, fingerprint: signer.fingerprint, public_key: signer.publicKey };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'list' && command !== 'add' && command !== 'retire') {
    throw new Error(USAGE);
  }

  const env = loadEnv();
  const { db, pool } = createDb(env);
  const keyring = Keyring.fromEnv(env);
  const signerService = createWrapperSigningKeyService({ db, keyring });
  try {
    if (command === 'list') {
      const signers = await signerService.allActive();
      process.stdout.write(
        JSON.stringify({
          ok: signers.length > 0,
          primary_kid: signers[0]?.kid ?? null,
          keys: signers.map(describe),
        }) + '\n',
      );
      process.stderr.write(STALE_CACHE_NOTE);
      return;
    }

    if (command === 'add') {
      const [privatePath, publicPath] = args;
      if (!privatePath || !publicPath) throw new Error(USAGE);
      const [privatePem, publicPem] = await Promise.all([
        readFile(privatePath, 'utf8'),
        readFile(publicPath, 'utf8'),
      ]);
      const expected = publicKeyB64(publicPem);
      if (publicKeyB64(privatePem) !== expected) {
        throw new Error('private/public signing key mismatch');
      }

      const keyId = await db.transaction(async (tx) => {
        const active = await tx
          .select()
          .from(wrapperSigningKeys)
          .where(eq(wrapperSigningKeys.active, 1))
          .for('update');
        if (active.length === 0) {
          throw new Error('no active signing key to rotate from; run setup-signing-key first');
        }
        for (const row of active) {
          let rowKey: string | null = null;
          try {
            rowKey = publicKeyB64(row.publicKey);
          } catch {
            rowKey = null;
          }
          if (rowKey === expected) throw new Error(`signing key is already active as id ${row.id}`);
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
        if (!insertedId) throw new Error('database did not return the new signing-key id');
        return insertedId;
      });

      signerService.invalidate();
      const signers = await signerService.allActive();
      const added = signers.find((signer) => signer.kid === String(keyId));
      if (!added || added.publicKey !== expected) {
        throw new Error('added signer read-back did not match the supplied key');
      }
      process.stdout.write(
        JSON.stringify({
          ok: true,
          added: describe(added),
          primary_kid: signers[0]!.kid,
          keys: signers.map(describe),
        }) + '\n',
      );
      process.stderr.write(STALE_CACHE_NOTE);
      return;
    }

    const keyId = Number(args[0]);
    if (!Number.isInteger(keyId) || keyId <= 0) throw new Error(USAGE);

    // Row count alone is not the invariant that matters: what must survive is a
    // key that can actually SIGN. A key that does not load is exempt, because
    // retiring one of those is a repair and can only improve matters.
    const loadable = await signerService.allActive();
    if (loadable.some((signer) => signer.kid === String(keyId)) && loadable.length < 2) {
      throw new Error(
        'refusing to retire the only usable active signing key; add its replacement first or the bakery goes 503',
      );
    }

    await db.transaction(async (tx) => {
      const active = await tx
        .select()
        .from(wrapperSigningKeys)
        .where(eq(wrapperSigningKeys.active, 1))
        .for('update');
      if (!active.some((row) => row.id === keyId)) {
        throw new Error(`signing key ${keyId} is not active`);
      }
      if (active.length < 2) {
        throw new Error(
          'refusing to retire the last active signing key row; add its replacement first or the bakery goes 503',
        );
      }
      await tx
        .update(wrapperSigningKeys)
        .set({ active: 0, rotatedAt: nowIso() })
        .where(and(eq(wrapperSigningKeys.id, keyId), eq(wrapperSigningKeys.active, 1)));
    });

    signerService.invalidate();
    const signers = await signerService.allActive();
    if (signers.some((signer) => signer.kid === String(keyId))) {
      throw new Error(`signing key ${keyId} is still signing after retirement`);
    }
    if (signers.length === 0) {
      throw new Error(
        `signing key ${keyId} was retired but no usable active signing key remains; import one with setup-signing-key`,
      );
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        retired_kid: String(keyId),
        primary_kid: signers[0]!.kid,
        keys: signers.map(describe),
      }) + '\n',
    );
    process.stderr.write(STALE_CACHE_NOTE);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
