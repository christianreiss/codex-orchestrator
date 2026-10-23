import { describe, expect, it } from 'vitest';
import { cacheManifest, cacheSourceAllowed } from '../../../src/services/communicator-cache.js';

describe('communicator cache manifests', () => {
  it('confirms bytes but keeps live status and quota in every response', () => {
    const input = { status: 'updated', quota: 12, config: { content: 'managed content' } };
    const first = cacheManifest(input, {}, 'codex', true, Date.now());
    const resource = first.resources[0]!;
    const second = cacheManifest(
      { ...input, quota: 55 },
      { [JSON.stringify(resource.path)]: resource.revision },
      'codex',
      true,
      Date.now(),
    );
    expect(second.resources[0]?.content).toBeUndefined();
    expect(second.body).toEqual({ status: 'updated', quota: 55, config: { content: null } });
    const changed = cacheManifest(
      { config: { content: 'changed without push' } },
      { [JSON.stringify(resource.path)]: resource.revision },
      'codex',
      true,
      Date.now(),
    );
    expect(changed.resources[0]?.revision).not.toBe(resource.revision);
    expect(changed.resources[0]?.content).toBeDefined();
  });

  it('bounds verified OAuth bytes by expiry and never caches opaque credentials', () => {
    const now = Date.now();
    const auth = {
      claudeAiOauth: { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: now + 12_000 },
    };
    const reply = cacheManifest(
      { account_id: 4, verification_state: 'verified', auth },
      {},
      'claude',
      true,
      now,
    );
    expect(reply.resources).toHaveLength(1);
    expect(reply.valid_for_ms).toBe(12_000);
    expect(reply.resources[0]?.valid_until).toBe(new Date(now + 12_000).toISOString());
    expect(
      cacheManifest({ verification_state: 'verified', auth }, {}, 'claude', false, now).resources,
    ).toHaveLength(0);
    expect(
      cacheManifest({ verification_state: 'quarantined', auth }, {}, 'claude', true, now).resources,
    ).toHaveLength(0);
    expect(
      cacheManifest(
        { verification_state: 'verified', auth: { OPENAI_API_KEY: 'test-key' } },
        {},
        'codex',
        true,
        now,
      ).resources,
    ).toHaveLength(0);
    const expired = cacheManifest(
      { verification_state: 'verified', auth },
      { [JSON.stringify(reply.resources[0]!.path)]: reply.resources[0]!.revision },
      'claude',
      true,
      now + 12_000,
    );
    // The native refresh package comes from this live read, never old RAM.
    expect(expired.resources).toEqual([]);
    expect(expired.body).toEqual({ verification_state: 'verified', auth });
    expect(expired.valid_for_ms).toBe(30_000);
    expect(cacheManifest({ verification_state: 'verified', auth }, {}, 'claude', false, now).valid_for_ms)
      .toBe(30_000);
  });

  it('keeps a live admission and content proof usable when OAuth access needs native refresh', () => {
    const now = Date.now();
    const auth = { claudeAiOauth: { accessToken: 'expired', refreshToken: 'native-refresh', expiresAt: now - 1 } };
    const admission = { account_id: 1, session_id: 'one-admission', verification_state: 'verified', auth };
    const input = { ...admission, data: admission, config: { content: 'current managed config' } };
    const first = cacheManifest(input, {}, 'claude', true, now);
    expect(first.valid_for_ms).toBe(30_000);
    expect(first.resources.map((resource) => resource.path)).toEqual([['config', 'content']]);
    const resource = first.resources[0]!;
    const second = cacheManifest(input, { [JSON.stringify(resource.path)]: resource.sha256 }, 'claude', true, now);
    expect(second.resources[0]?.content).toBeUndefined();
    expect(second.body).toEqual({ ...admission, data: admission, config: { content: null } });
    expect(second.valid_for_ms).toBe(30_000);
  });

  it('caches only selected skill reads, keeping RPC IDs outside the result', () => {
    const rpc = { jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'skill body' }] } };
    expect(cacheManifest(rpc, {}, 'grok', true, Date.now()).body).toEqual({ ...rpc, result: null });
    expect(
      cacheSourceAllowed('POST', '/mcp', { ...rpc, method: 'tools/call', params: { name: 'secret_get' } }),
    ).toBe(false);
    expect(
      cacheSourceAllowed('POST', '/mcp', {
        ...rpc,
        method: 'tools/call',
        params: { name: 'resource_read', arguments: { uri: 'skill://sample/scripts/check.py' } },
      }),
    ).toBe(true);
    expect(cacheSourceAllowed('GET', '/skills?engine=claude', {})).toBe(true);
    for (const path of [
      '/sync/cache',
      '/admin/hosts',
      '//skills',
      '/skills/../auth',
      '/skills?anything=1',
      '/skills?engine=codex&engine=claude',
    ]) {
      expect(cacheSourceAllowed('GET', path, {}), path).toBe(false);
    }
    expect(cacheSourceAllowed('POST', '/auth', { command: 'store' })).toBe(false);
  });
});
