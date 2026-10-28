import { describe, it, expect, vi } from 'vitest';
import type { Host } from '../../../src/db/schema.js';
import { hashApiKey } from '../../../src/util/api-key-helpers.js';

const state = vi.hoisted(() => ({ rows: new Map<number, unknown>() }));
vi.mock('../../../src/control-plane/state/runtime.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  ownerRuntimeFor: () => ({ assertOwner() {}, state: { snapshot: () => ({ hosts: { get: (id: number) => state.rows.get(id) } }) } }),
}));
vi.mock('../../../src/control-plane/state/host-activity.js', () => ({ observeHostActivity() {}, hostActivity: () => new Map() }));

const { recordHostContact } = await import('../../../src/services/host-lifecycle.js');
const { requestHost } = await import('../../../src/control-plane/state/admission.js');

const KEY = 'sk-host-key';
const row = (patch: Record<string, unknown> = {}) =>
  ({ id: 7, fqdn: 'owner.test', status: 'active', engines: 'codex', apiKeyHash: 'stored-hash', credentialLookupHash: hashApiKey(KEY), expiresAt: null, ...patch });

describe('recordHostContact with the in-memory owner state', () => {
  it('accepts a host authenticated by an MCP session token, which presents no API key', async () => {
    state.rows.set(7, row());
    const sessionHost = requestHost(row() as never, '');
    await expect(recordHostContact({} as never, sessionHost as Host)).resolves.toMatchObject({ id: 7 });
  });
  it('still rejects a session host once the stored credential was rotated', async () => {
    const sessionHost = requestHost(row() as never, '');
    state.rows.set(7, row({ apiKeyHash: 'rotated-hash' }));
    await expect(recordHostContact({} as never, sessionHost as Host)).rejects.toMatchObject({ code: 'invalid_api_key' });
  });
  it('still rejects a presented key that no longer matches the row', async () => {
    state.rows.set(7, row());
    const wrong = requestHost(row() as never, 'sk-other-key');
    await expect(recordHostContact({} as never, wrong as Host)).rejects.toMatchObject({ code: 'invalid_api_key' });
    await expect(recordHostContact({} as never, requestHost(row() as never, KEY) as Host)).resolves.toMatchObject({ id: 7 });
  });
});
