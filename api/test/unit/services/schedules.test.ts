import { describe, it, expect } from 'vitest';
import { scheduleInput, nextOccurrence } from '../../../src/services/schedules/timing.js';
import { targetGoneSince, targetIsGone } from '../../../src/services/schedules/staleness.js';
import { buildManagedWakeCronSkill } from '../../../src/services/managed-wake-cron-skill.js';
const base = {
  name: 'Keep working',
  target: 'agent:12345678-1234-4234-8234-123456789abc',
  prompt: 'Continue the task',
  kind: 'interval',
  interval_minutes: 5,
};
describe('Wake/Cron timing and opt-in contract', () => {
  it('defaults recovery off and Europe/Berlin', () => {
    expect(scheduleInput.parse(base)).toMatchObject({ persistent: false, timezone: 'Europe/Berlin' });
  });
  it('requires an explicit timeout for recovery and rejects stray timing fields', () => {
    expect(scheduleInput.safeParse({ ...base, persistent: true }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...base, persistent: true, progress_timeout_seconds: 90 }).success).toBe(
      true,
    );
    expect(scheduleInput.safeParse({ ...base, at: '2026-10-10T10:00:00Z' }).success).toBe(false);
    expect(scheduleInput.safeParse({ ...base, interval_minutes: 0 }).success).toBe(false);
  });
  it('rejects bad zones, cron and oversized UTF-8 prompts', () => {
    expect(scheduleInput.safeParse({ ...base, timezone: 'Neverland' }).success).toBe(false);
    expect(
      scheduleInput.safeParse({ ...base, kind: 'cron', interval_minutes: null, cron: '* * * * * *' }).success,
    ).toBe(false);
    expect(scheduleInput.safeParse({ ...base, prompt: '🙂'.repeat(8000) }).success).toBe(false);
  });
  it('coalesces interval downtime from the current tick', () => {
    expect(nextOccurrence(scheduleInput.parse(base), new Date('2026-10-08T10:00:00Z'))).toBe(
      '2026-10-08T10:05:00.000Z',
    );
  });
  it('skips a nonexistent spring clock hour', () => {
    const input = scheduleInput.parse({ ...base, kind: 'cron', interval_minutes: null, cron: '30 2 * * *' });
    expect(nextOccurrence(input, new Date('2026-03-28T02:00:00Z'))).toBe('2026-03-30T00:30:00.000Z');
  });
  it('skips spring clock shifts for hour lists too', () => {
    const input = scheduleInput.parse({
      ...base,
      kind: 'cron',
      interval_minutes: null,
      cron: '30 2,4 * * *',
    });
    expect(nextOccurrence(input, new Date('2026-03-29T00:00:00Z'))).toBe('2026-03-29T02:30:00.000Z');
  });
  it('emits the repeated autumn local hour once', () => {
    const input = scheduleInput.parse({ ...base, kind: 'cron', interval_minutes: null, cron: '30 2 * * *' });
    const first = nextOccurrence(input, new Date('2026-10-24T02:00:00Z'))!;
    expect(first).toBe('2026-10-25T00:30:00.000Z');
    expect(nextOccurrence(input, new Date(first))).toBe('2026-10-26T01:30:00.000Z');
  });
  it('serves a shared managed skill with all tools and explicit opt-in guidance', () => {
    const skill = buildManagedWakeCronSkill('2026-10-08T00:00:00Z');
    expect(skill.engine).toBeNull();
    expect(skill.managed).toBe(true);
    for (const tool of [
      'schedule_list',
      'schedule_get',
      'schedule_create',
      'schedule_update',
      'schedule_delete',
    ])
      expect(skill.manifest).toContain(tool);
    expect(skill.manifest).toContain('Persistent recovery is OFF by default');
  });
});

describe('Wake/Cron target staleness (24 h rule)', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const live = { archivedAt: null, lastSeenAt: hoursAgo(0) };
  it('treats a live session as alive however stale its last-seen is', () => {
    const session = { endedAt: null, bridgeExpiresAt: new Date(now.getTime() + 3_600_000).toISOString() };
    expect(targetGoneSince({ ...live, lastSeenAt: hoursAgo(72) }, session, now.toISOString())).toBeNull();
    expect(targetIsGone({ ...live, lastSeenAt: hoursAgo(72) }, session, now)).toBe(false);
  });
  it('counts an ended or bridge-expired session gone only after 24 h', () => {
    const ended = (h: number) => ({ endedAt: hoursAgo(h), bridgeExpiresAt: hoursAgo(h) });
    expect(targetIsGone({ ...live, lastSeenAt: hoursAgo(25) }, ended(25), now)).toBe(true);
    expect(targetIsGone({ ...live, lastSeenAt: hoursAgo(23) }, ended(23), now)).toBe(false);
    expect(targetIsGone({ ...live, lastSeenAt: hoursAgo(25) }, { endedAt: null, bridgeExpiresAt: hoursAgo(30) }, now)).toBe(true);
  });
  it('never counts the agent gone before it was last seen', () => {
    expect(targetIsGone({ ...live, lastSeenAt: hoursAgo(2) }, { endedAt: hoursAgo(48), bridgeExpiresAt: hoursAgo(48) }, now)).toBe(false);
  });
  it('treats missing and archived addresses as gone and a session-less one by last-seen', () => {
    expect(targetIsGone(null, null, now)).toBe(true);
    expect(targetIsGone({ archivedAt: hoursAgo(1), lastSeenAt: hoursAgo(0) }, null, now)).toBe(false);
    expect(targetGoneSince({ archivedAt: hoursAgo(30), lastSeenAt: hoursAgo(0) }, null, now.toISOString())).toBe(hoursAgo(30));
    expect(targetIsGone({ archivedAt: null, lastSeenAt: hoursAgo(30) }, null, now)).toBe(true);
    expect(targetIsGone({ archivedAt: null, lastSeenAt: hoursAgo(3) }, null, now)).toBe(false);
  });
});
