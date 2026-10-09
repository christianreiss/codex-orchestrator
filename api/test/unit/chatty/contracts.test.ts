import { describe, it, expect } from 'vitest';
import {
  modelResponseSchema,
  modelSafe,
  signature,
  messageSchema,
} from '../../../src/services/chatty/contracts.js';
import { administrationTools, checkSnapshot } from '../../../src/services/chatty/tools.js';
import { roleHasCapability } from '../../../src/security/capabilities.js';
import { quotaExhausted } from '../../../src/services/chatty/inference.js';

describe('Chatty contracts', () => {
  it('has a strict closed model output protocol', () => {
    for (const payload of [
      { kind: 'shell', command: 'id' },
      { kind: 'answer', text: 'x', tool: 'evil' },
      { kind: 'tool_call', name: '/admin/users', arguments: {} },
      { kind: 'tool_call', name: 'read', arguments: 'raw' },
    ])
      expect(modelResponseSchema.safeParse(payload).success).toBe(false);
    expect(modelResponseSchema.parse({ kind: 'answer', text: 'Hallo' })).toEqual({
      kind: 'answer',
      text: 'Hallo',
      sources: [],
    });
  });
  it('validates context identifiers rather than accepting arbitrary page content', () => {
    expect(
      messageSchema.safeParse({
        client_message_id: crypto.randomUUID(),
        generation: 1,
        text: 'x',
        context: { page: 'hosts', html: '<secret>' },
      }).success,
    ).toBe(false);
  });
  it('removes credential fields recursively', () => {
    expect(
      modelSafe({
        passwordHash: 'x',
        keyEnc: 'x',
        auth_json: 'x',
        api_key: 'x',
        rows: [{ token: 'x', name: 'okay' }],
      }),
    ).toEqual({ rows: [{ name: 'okay' }] });
  });
  it('binds snapshots independently of JSON property order', () => {
    expect(signature({ a: 1, b: 2 })).toBe(signature({ b: 2, a: 1 }));
    expect(() => checkSnapshot({ a: 1 }, { a: 2 })).toThrow('Target changed');
  });
  it('exposes Chatty only to owner and admin', () => {
    for (const role of ['owner', 'admin']) expect(roleHasCapability(role, 'chatty.use')).toBe(true);
    for (const role of ['fleet_operator', 'trusted_user', 'viewer', 'user'])
      expect(roleHasCapability(role, 'chatty.use')).toBe(false);
  });
  it('honors exhausted windows until their reset time', () => {
    expect(
      quotaExhausted(
        { weekly_used_percent: 95, weekly_resets_at: '2026-12-01' },
        90,
        Date.parse('2026-10-01'),
      ),
    ).toBe(true);
    expect(
      quotaExhausted(
        { weekly_used_percent: 95, weekly_resets_at: '2026-09-01' },
        90,
        Date.parse('2026-10-01'),
      ),
    ).toBe(false);
  });
  it('provides unique schemas and no tool capable of dispatching host work', () => {
    const tools = administrationTools();
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      if (tool.write) expect(tool.snapshot).toBeTypeOf('function');
    }
    for (const name of ['agent_send', 'schedule_create', 'watchdog_enable', 'shell', 'http_request'])
      expect(tools.map((t) => t.name)).not.toContain(name);
    expect(() =>
      tools
        .find((t) => t.name === 'schedule_pause')!
        .parse({ id: crypto.randomUUID(), version: 1, enabled: true }),
    ).toThrow();
    for (const name of ['host_delete', 'engine_set', 'user_delete', 'config_store'])
      expect(tools.find((t) => t.name === name)?.confirm).toBe(true);
  });
});
