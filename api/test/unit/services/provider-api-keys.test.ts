import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { ProviderApiKeyService } from '../../../src/services/provider-api-keys.js';
import { sha256 } from '../../../src/security/hash.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { memoryOwner, persisted, type MemoryOwner } from '../../helpers/memory-owner.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const OPENAI_KEY = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901';
const OPENAI_KEY_2 = 'sk-proj-ZYXWVUTSRQPONMLKJIHGFEDCBA987654321099';
const GATEWAY_KEY = `sk-cdx-${'a'.repeat(64)}`;

const harnesses: MemoryOwner[] = [];
afterEach(() => harnesses.splice(0).forEach((h) => h.close()));

function setup(seed: Record<string, Record<string, unknown>[]> = {}) {
  const h = memoryOwner(seed);
  harnesses.push(h);
  const commands: Array<{ kind?: string; payload?: unknown }> = [];
  const execute = h.owner.execute;
  (h.owner as { execute: typeof execute }).execute = (command) => {
    commands.push(command as unknown as { kind?: string; payload?: unknown });
    return execute(command);
  };
  const keyring = testKeyring();
  const service = new ProviderApiKeyService({
    db: h.db,
    keyring,
    policy: { privateHosts: new Set(), ownHosts: new Set(['orchestrator.example.org']) },
  });
  return { ...h, service, keyring, commands };
}

/** Everything written outside the encrypted content: audit rows and command payloads. */
function visibleTrail(t: ReturnType<typeof setup>): string {
  return JSON.stringify([persisted(t.fake, schema.adminEvents), t.commands.map((c) => c.payload)]);
}

describe('ProviderApiKeyService', () => {
  it('stores only an envelope and a hint, and never leaks the key into audit or command payloads', async () => {
    const t = setup();
    const created = await t.service.create({ provider: 'openai', label: ' Main ', key: ` ${OPENAI_KEY} `, adminUserId: 7 });
    expect(created).toMatchObject({
      provider: 'openai',
      label: 'Main',
      keyHint: 'sk-proj-…8901',
      baseUrl: null,
      sortOrder: 0,
      state: 'active',
      verificationState: 'unverified',
      createdByAdminUserId: 7,
    });
    expect(created).not.toHaveProperty('keyEnc');
    expect(created).not.toHaveProperty('keyHash');
    const envelope = t.state.snapshot().content('providerApiKeys', created.id, 'keyEnc');
    expect(envelope).toMatch(/^sbox:v1/);
    expect(decrypt(envelope!, t.keyring)).toBe(OPENAI_KEY);
    const trail = visibleTrail(t);
    expect(trail).not.toContain(OPENAI_KEY);
    expect(trail).not.toContain(sha256(OPENAI_KEY));
    expect(trail).not.toContain('sbox:v1');
    expect(persisted(t.fake, schema.adminEvents).map((e) => e.type)).toEqual(['provider_key.created']);
    const list = await t.service.list();
    expect(JSON.stringify(list)).not.toContain(OPENAI_KEY);
    expect(list[0]).not.toHaveProperty('keyHash');
  });

  it('refuses our own gateway keys by shape and by stored hash', async () => {
    const lookalike = `sk-zzz-${'b'.repeat(40)}`;
    const t = setup({
      openaiApiKeys: [
        {
          id: 1, name: 'gw', keyPrefix: 'x', keyHash: sha256(lookalike), keyEnc: null, adminUserId: null, isActive: 1,
          useCount: 0, lastUsedAt: null, expiresAt: null, engine: 'codex', backendEngine: null, source: null,
          createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
        },
      ],
    });
    await expect(t.service.create({ provider: 'openai', label: 'x', key: GATEWAY_KEY })).rejects.toMatchObject({
      status: 400,
      code: 'gateway_key_not_allowed',
    });
    await expect(t.service.create({ provider: 'openai', label: 'x', key: lookalike })).rejects.toMatchObject({
      status: 400,
      code: 'gateway_key_not_allowed',
    });
    expect(await t.service.list()).toEqual([]);
  });

  it('dedupes per provider and validates input without echoing it', async () => {
    const t = setup();
    await t.service.create({ provider: 'openai', label: 'a', key: OPENAI_KEY });
    await expect(t.service.create({ provider: 'openai', label: 'b', key: OPENAI_KEY })).rejects.toMatchObject({
      status: 409,
      code: 'provider_key_duplicate',
    });
    await expect(t.service.create({ provider: 'xai', label: 'b', key: OPENAI_KEY })).resolves.toMatchObject({ provider: 'xai' });
    await expect(t.service.create({ provider: 'gemini', label: 'b', key: OPENAI_KEY_2 })).rejects.toMatchObject({ param: 'provider' });
    await expect(t.service.create({ provider: 'openai', label: '', key: OPENAI_KEY_2 })).rejects.toMatchObject({ param: 'label' });
    await expect(t.service.create({ provider: 'openai', label: 'b', key: 'short' })).rejects.toMatchObject({ param: 'key' });
    await expect(t.service.create({ provider: 'openai', label: 'b', key: 'sk-has space-0123456789' })).rejects.toMatchObject({ param: 'key' });
    const badUrl = t.service.create({ provider: 'openai', label: 'b', key: OPENAI_KEY_2, base_url: 'https://user:sk-leak@example.com/v1' });
    await expect(badUrl).rejects.toMatchObject({ status: 400, code: 'invalid_base_url', param: 'base_url' });
    await badUrl.catch((err: Error) => expect(err.message).not.toContain('sk-leak'));
    await expect(
      t.service.create({ provider: 'openai', label: 'b', key: OPENAI_KEY_2, base_url: 'https://orchestrator.example.org/v1' }),
    ).rejects.toMatchObject({ code: 'invalid_base_url' });
  });

  it('keeps a failover order per provider and reorders only with the exact id set', async () => {
    const t = setup();
    const a = await t.service.create({ provider: 'anthropic', label: 'a', key: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa' });
    const b = await t.service.create({ provider: 'anthropic', label: 'b', key: 'sk-ant-api03-bbbbbbbbbbbbbbbbbbbb' });
    const c = await t.service.create({ provider: 'openai', label: 'c', key: OPENAI_KEY });
    expect([a.sortOrder, b.sortOrder, c.sortOrder]).toEqual([0, 1, 0]);
    await expect(t.service.reorder('anthropic', [b.id])).rejects.toMatchObject({ status: 409, code: 'provider_key_order_mismatch' });
    await expect(t.service.reorder('anthropic', [b.id, c.id])).rejects.toMatchObject({ code: 'provider_key_order_mismatch' });
    await expect(t.service.reorder('anthropic', [b.id, b.id])).rejects.toMatchObject({ status: 400, param: 'ids' });
    const ordered = await t.service.reorder('anthropic', [b.id, a.id]);
    expect(ordered.map((row) => [row.id, row.sortOrder])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ]);
    expect((await t.service.candidates('anthropic')).map((k) => k.id)).toEqual([b.id, a.id]);
  });

  it('serves only active, not-invalid keys as candidates, decrypted with the effective base URL', async () => {
    const t = setup();
    const a = await t.service.create({ provider: 'openai', label: 'a', key: OPENAI_KEY });
    const b = await t.service.create({ provider: 'openai', label: 'b', key: OPENAI_KEY_2, base_url: 'https://proxy.example.com/openai/v1/' });
    expect(await t.service.candidates('openai')).toEqual([
      expect.objectContaining({ id: a.id, key: OPENAI_KEY, baseUrl: 'https://api.openai.com/v1' }),
      expect.objectContaining({ id: b.id, key: OPENAI_KEY_2, baseUrl: 'https://proxy.example.com/openai/v1' }),
    ]);
    await t.service.setState(a.id, 'paused');
    expect((await t.service.candidates('openai')).map((k) => k.id)).toEqual([b.id]);
    await expect(t.service.setState(a.id, 'off')).rejects.toMatchObject({ param: 'state' });
    const secret = (await t.service.secret(b.id))!;
    await t.service.recordVerification(secret, { state: 'invalid', reason: 'unauthorized (HTTP 401)', status: 401 });
    expect(await t.service.candidates('openai')).toEqual([]);
    expect((await t.service.counts()).openai).toEqual({ total: 2, active: 1, usable: 0 });
  });

  it('resets verification when the key or base URL changes, and ignores a stale verification', async () => {
    const t = setup();
    const a = await t.service.create({ provider: 'openai', label: 'a', key: OPENAI_KEY });
    const before = (await t.service.secret(a.id))!;
    await t.service.recordVerification(before, { state: 'valid', reason: 'ok (HTTP 200)', status: 200 });
    expect((await t.service.get(a.id))?.verificationState).toBe('valid');
    expect((await t.service.update(a.id, { label: 'renamed' })).verificationState).toBe('valid');
    const rotated = await t.service.update(a.id, { key: OPENAI_KEY_2 });
    expect(rotated).toMatchObject({ verificationState: 'unverified', verificationReason: null, keyHint: 'sk-proj-…1099' });
    // A verification of the old key arriving late must not mark the new one.
    expect(await t.service.recordVerification(before, { state: 'invalid', reason: 'unauthorized (HTTP 401)', status: 401 })).toBeNull();
    expect((await t.service.get(a.id))?.verificationState).toBe('unverified');
    const current = (await t.service.secret(a.id))!;
    await t.service.recordVerification(current, { state: 'valid', reason: 'ok (HTTP 200)', status: 200 });
    expect((await t.service.update(a.id, { base_url: 'https://proxy.example.com/v1' })).verificationState).toBe('unverified');
    expect((await t.service.update(a.id, { base_url: null })).baseUrl).toBeNull();
    await expect(t.service.update(a.id, {})).rejects.toMatchObject({ status: 400 });
    await expect(t.service.update(999, { label: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(visibleTrail(t)).not.toContain(OPENAI_KEY_2);
  });

  it('lets the background re-check only invalidate, audited as provider_key.invalidated', async () => {
    const t = setup();
    const a = await t.service.create({ provider: 'xai', label: 'a', key: 'xai-abcdefghijklmnopqrstuvwxyz' });
    const secret = (await t.service.secret(a.id))!;
    expect(await t.service.recordVerification(secret, { state: 'error', reason: 'upstream_error (HTTP 500)', status: 500 }, { background: true })).toBeNull();
    expect(await t.service.recordVerification(secret, { state: 'valid', reason: 'ok (HTTP 200)', status: 200 }, { background: true })).toBeNull();
    const invalidated = await t.service.recordVerification(secret, { state: 'invalid', reason: 'unauthorized (HTTP 401)', status: 401 }, { background: true });
    expect(invalidated).toMatchObject({ verificationState: 'invalid', verificationReason: 'unauthorized (HTTP 401)' });
    expect(persisted(t.fake, schema.adminEvents).map((e) => e.type)).toEqual(['provider_key.created', 'provider_key.invalidated']);
    expect(t.commands.at(-1)).toMatchObject({ kind: 'provider_key.invalidate', principal: 'system:provider-key-verify' });
  });

  it('deletes a key and its envelope', async () => {
    const t = setup();
    const a = await t.service.create({ provider: 'moonshot', label: 'a', key: 'sk-moonshotabcdefghijklmnop' });
    expect(await t.service.delete(a.id)).toBe(true);
    expect(await t.service.delete(a.id)).toBe(false);
    expect(t.state.snapshot().content('providerApiKeys', a.id, 'keyEnc')).toBeUndefined();
    expect(persisted(t.fake, schema.providerApiKeys)).toEqual([]);
  });
});
