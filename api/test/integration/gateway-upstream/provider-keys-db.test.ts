import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { inArray, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { ownerRuntimeFor } from '../../../src/control-plane/state/runtime.js';
import { ProviderApiKeyService } from '../../../src/services/provider-api-keys.js';
import { flushProviderKeyTelemetry, recordProviderKeyError } from '../../../src/services/gateway-upstream/telemetry.js';
import { sha256 } from '../../../src/security/hash.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

/**
 * Provider API keys through the real owner and MySQL. The unit tier runs the
 * same service over `db-fake`, which cannot show that the encrypted key is
 * written to `key_enc`, re-hydrated as owner content after a restart, and
 * decrypted again for the forward; nor that nothing else on disk (audit rows,
 * command receipts) carries the key or its hash.
 */
const config = readDbConfig();
describe.skipIf(!config)('provider API keys on real MySQL', () => {
  it('persists, re-hydrates and decrypts keys across an owner restart without leaking them', { timeout: 120_000 }, async () => {
    const pool = mysql.createPool({ ...config!, connectionLimit: 4 });
    // Plain SQL reads and cleanup; every owner binds its own service handle.
    const db = drizzle(pool, { schema, mode: 'default' });
    let handle = db;
    const env = loadTestEnv(),
      keyring = testKeyring();
    const nonce = randomUUID().slice(0, 8);
    const label = `ztest-pk-${nonce}`;
    const keyA = `sk-proj-${nonce}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const keyB = `sk-proj-${nonce}BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
    const keyA2 = `sk-proj-${nonce}CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`;
    const policy = { privateHosts: new Set<string>(), ownHosts: new Set<string>() };
    const epochs: string[] = [];
    const errors: unknown[] = [];
    const ids: number[] = [];
    let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined;
    const start = async () => {
      handle = drizzle(pool, { schema, mode: 'default' });
      owner = await createOwnedControlPlane({ pool, handle, env, keyring, error: (error) => errors.push(error) });
      epochs.push(owner.runtime.state.revision().epoch);
      return new ProviderApiKeyService({ db: handle, keyring, policy });
    };
    const restart = async () => {
      await owner?.close();
      owner = undefined;
      return start();
    };
    try {
      let service = await start();
      const a = await service.create({ provider: 'openai', label, key: keyA, adminUserId: null });
      const b = await service.create({ provider: 'openai', label, key: keyB, base_url: 'https://proxy.example.com/v1' });
      ids.push(a.id, b.id);
      expect(a).not.toHaveProperty('keyEnc');

      const [rawA] = await db.select().from(schema.providerApiKeys).where(inArray(schema.providerApiKeys.id, [a.id]));
      expect(rawA!.keyEnc).toMatch(/^sbox:v1/);
      expect(rawA!.keyEnc).not.toContain(keyA);
      expect(rawA!.keyHash).toBe(sha256(keyA));

      service = await restart();
      const mine = <T extends { id: number }>(rows: T[]) => rows.filter((row) => ids.includes(row.id));
      expect(mine(await service.candidates('openai')).map((c) => [c.id, c.key, c.baseUrl])).toEqual([
        [a.id, keyA, 'https://api.openai.com/v1'],
        [b.id, keyB, 'https://proxy.example.com/v1'],
      ]);

      await service.update(a.id, { key: keyA2 });
      await service.reorder('openai', (await service.list()).filter((row) => row.provider === 'openai').map((row) => row.id).reverse());
      await service.setState(b.id, 'paused');
      recordProviderKeyError(handle, a.id, 'rate_limited', 429);
      await flushProviderKeyTelemetry(ownerRuntimeFor(handle)!);

      service = await restart();
      const after = mine(await service.candidates('openai'));
      expect(after.map((c) => [c.id, c.key])).toEqual([[a.id, keyA2]]);
      expect(await service.get(a.id)).toMatchObject({
        verificationState: 'unverified',
        lastErrorStatus: 429,
        lastErrorReason: 'rate_limited (HTTP 429)',
      });
      expect((await service.get(b.id))?.state).toBe('paused');

      const candidate = (await service.secret(a.id))!;
      await service.recordVerification(candidate, { state: 'invalid', reason: 'unauthorized (HTTP 401)', status: 401 }, { background: true });
      service = await restart();
      expect(mine(await service.candidates('openai'))).toEqual([]);
      expect((await service.get(a.id))?.verificationState).toBe('invalid');

      expect(await service.delete(b.id)).toBe(true);
      expect(await db.select().from(schema.providerApiKeys).where(inArray(schema.providerApiKeys.id, [b.id]))).toEqual([]);

      const audit = await db.select().from(schema.adminEvents).where(like(schema.adminEvents.type, 'provider_key.%'));
      const ours = audit.filter((row) => ids.includes(Number((row.payload as { key_id?: unknown } | null)?.key_id)));
      expect(ours.map((row) => row.type)).toEqual(
        expect.arrayContaining(['provider_key.created', 'provider_key.updated', 'provider_key.state', 'provider_key.invalidated', 'provider_key.deleted']),
      );
      const receipts = await db
        .select()
        .from(schema.controlPlaneCommandReceipts)
        .where(inArray(schema.controlPlaneCommandReceipts.ownerEpoch, epochs));
      const onDisk = JSON.stringify([ours, receipts], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
      for (const secret of [keyA, keyB, keyA2, sha256(keyA), sha256(keyB), sha256(keyA2)]) expect(onDisk).not.toContain(secret);
      expect(errors).toEqual([]);
    } finally {
      await owner?.close();
      if (ids.length) {
        await db.delete(schema.providerApiKeys).where(inArray(schema.providerApiKeys.id, ids));
      }
      if (epochs.length) {
        await db.delete(schema.controlPlaneCommandReceipts).where(inArray(schema.controlPlaneCommandReceipts.ownerEpoch, epochs));
      }
      await pool.end();
    }
  });
});
