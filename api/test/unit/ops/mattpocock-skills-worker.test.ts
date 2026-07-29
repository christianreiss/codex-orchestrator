import { describe, expect, it, vi } from 'vitest';
import {
  MATTPOCOCK_SKILLS_REFRESH_INTERVAL_MS,
  runMattPocockSkillsWorkerTick,
} from '../../../src/ops/mattpocock-skills-worker.js';
import type { SkillSourceState } from '../../../src/services/mattpocock-skills.js';

function state(overrides: Partial<SkillSourceState> = {}): SkillSourceState {
  return {
    source: 'github:mattpocock/skills',
    repository: 'https://github.com/mattpocock/skills',
    ref: 'main',
    enabled: false,
    auto_update: true,
    status: 'disabled',
    revision: null,
    upstream_version: null,
    skill_count: 0,
    file_count: 0,
    last_checked_at: null,
    last_synced_at: null,
    last_error: null,
    ...overrides,
  };
}

describe('mattpocock skills update worker', () => {
  it('does no outbound refresh while the source is disabled', async () => {
    const refresh = vi.fn();
    const result = await runMattPocockSkillsWorkerTick({
      service: { getState: async () => state(), refresh },
    });
    expect(result).toBe('disabled');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('leaves an enabled but pinned source alone', async () => {
    const refresh = vi.fn();
    const result = await runMattPocockSkillsWorkerTick({
      service: { getState: async () => state({ enabled: true, auto_update: false }), refresh },
    });
    expect(result).toBe('manual');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not refresh a recently checked source', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const refresh = vi.fn();
    const result = await runMattPocockSkillsWorkerTick({
      service: {
        getState: async () => state({
          enabled: true,
          last_checked_at: new Date(now - MATTPOCOCK_SKILLS_REFRESH_INTERVAL_MS + 1).toISOString(),
        }),
        refresh,
      },
      now: () => now,
    });
    expect(result).toBe('fresh');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes a stale enabled auto-updating source', async () => {
    const now = Date.parse('2026-07-29T12:00:00Z');
    const refreshed = state({ enabled: true, status: 'ok' });
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const result = await runMattPocockSkillsWorkerTick({
      service: {
        getState: async () => state({
          enabled: true,
          last_checked_at: new Date(now - MATTPOCOCK_SKILLS_REFRESH_INTERVAL_MS).toISOString(),
        }),
        refresh,
      },
      now: () => now,
    });
    expect(result).toBe('refreshed');
    expect(refresh).toHaveBeenCalledWith({ force: false });
  });
});
