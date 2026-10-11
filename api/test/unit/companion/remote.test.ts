import { describe, expect, it } from 'vitest';
import {
  companionStartSchema,
  contactPrompt,
  hostStartable,
} from '../../../src/services/companion/remote.js';

describe('Android remote start contract', () => {
  it('defaults to contact only without granting project work', () => {
    const parsed = companionStartSchema.parse({
      host_id: 1,
      engine: 'claude',
      client_message_id: '2a235f04-d718-4cff-b92f-84ac431e655b',
    });
    expect(parsed.task).toBe('');
    expect(contactPrompt(parsed.task)).toContain('Do not inspect or change project files');
    expect(contactPrompt(parsed.task)).toContain('cxx portal say');
    expect(contactPrompt('Inspect the logs')).toContain('Operator task:\nInspect the logs');
  });
  it('only starts fresh hosts with free capacity and an available engine', () => {
    const host = { health: { reasons: [] as string[] }, engines: ['grok'], free_slots: 1 };
    expect(hostStartable(host)).toBe(true);
    expect(hostStartable({ ...host, health: { reasons: ['engines_partially_ready'] } })).toBe(true);
    for (const reason of ['reconnecting', 'heartbeat_expired', 'daemon_error', 'host_access_blocked'])
      expect(hostStartable({ ...host, health: { reasons: [reason] } })).toBe(false);
    expect(hostStartable({ ...host, free_slots: 0 })).toBe(false);
    expect(hostStartable({ ...host, engines: [] })).toBe(false);
  });
});
