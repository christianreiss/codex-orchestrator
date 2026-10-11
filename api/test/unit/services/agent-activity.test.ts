import { describe, it, expect } from 'vitest';
import {
  acceptActivity,
  activityView,
  activityInputSchema,
  type ActivityInput,
} from '../../../src/services/agent-activity.js';
const now = Date.parse('2026-10-11T12:00:00Z');
const input: ActivityInput = {
  generation: '11111111-1111-4111-8111-111111111111',
  binding_generation: 3,
  native_session_id: 'native',
  sequence: 1,
  state: 'working',
  wait_reason: null,
  source: 'codex-thread',
  evidence_age_ms: 0,
};
const session = {
  engine: 'codex',
  upstreamSessionId: 'native',
  bindingGeneration: 3,
  endedAt: null,
  receiver: {
    generation: input.generation,
    native_session_id: 'native',
    protocol: 'codex-queue-v1',
    heartbeat_at: new Date(now).toISOString(),
    failure: null,
    probes: { portal: {} },
  },
};
describe('native activity observation', () => {
  it('expires evidence independently of wrapper contact and turn age', () => {
    const activity = acceptActivity(session, input, now);
    expect(activityView({ ...session, activity }, now + 44_999).state).toBe('working');
    expect(activityView({ ...session, activity }, now + 45_000).state).toBe('unknown');
  });
  it('does not refresh hook evidence or duplicate receipts', () => {
    const activity = acceptActivity(session, { ...input, evidence_age_ms: 40_000 }, now)!;
    expect(activity.expires_at).toBe(new Date(now + 5000).toISOString());
    expect(acceptActivity({ ...session, activity }, { ...input, evidence_age_ms: 0 }, now + 1000)).toBeNull();
    expect(
      acceptActivity({ ...session, activity }, { ...input, sequence: 2, evidence_age_ms: 41_000 }, now + 1000)
        ?.expires_at,
    ).toBe(activity.expires_at);
  });
  it.each([
    { binding_generation: 2 },
    { native_session_id: 'other' },
    { generation: '22222222-2222-4222-8222-222222222222' },
    { source: 'grok-session' },
  ])('rejects stale or cross-engine ownership %j', (patch) => {
    expect(() => acceptActivity(session, { ...input, ...patch } as ActivityInput, now)).toThrow(
      /no longer owns/,
    );
  });
  it('invalidates observations on reconnect, disconnect and finish', () => {
    const activity = acceptActivity(session, input, now);
    for (const patch of [
      { bindingGeneration: 4 },
      { upstreamSessionId: 'other' },
      { endedAt: new Date(now).toISOString() },
      { receiver: { ...session.receiver, failure: 'disconnected' } },
    ]) {
      expect(activityView({ ...session, activity, ...patch }, now).state).toBe('unknown');
    }
  });
  it('keeps work ahead of portal questions and offers an explicit input wait otherwise', () => {
    expect(activityView({ ...session, activity: acceptActivity(session, input, now) }, now, true).state).toBe(
      'working',
    );
    expect(activityView(session, now, true)).toMatchObject({
      state: 'waiting',
      source: 'portal-question',
      wait_reason: 'input',
    });
  });
  it('validates wire state and bounded ages', () => {
    expect(activityInputSchema.safeParse(input).success).toBe(true);
    for (const patch of [
      { state: 'busy' },
      { state: 'waiting' },
      { evidence_age_ms: -1 },
      { sequence: 0 },
      { wait_reason: 'approval' },
    ]) {
      expect(activityInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
});
