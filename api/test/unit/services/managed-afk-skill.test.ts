import { describe, expect, it } from 'vitest';
import {
  MANAGED_AFK_SKILL_SLUG,
  buildManagedAfkSkill,
  isManagedAfkSlug,
} from '../../../src/services/managed-afk-skill.js';

describe('managed #afk portal skill', () => {
  const skill = buildManagedAfkSkill('2026-07-29T00:00:00Z');

  it('uses the scoped relay instead of Matrix as an inbound channel', () => {
    expect(skill.manifest).toContain('cxx portal notify');
    expect(skill.manifest).toContain('cxx portal wait');
    expect(skill.manifest).toContain('cxx portal accept');
    expect(skill.manifest).toContain('cxx portal say');
    expect(skill.manifest).toContain('cxx portal ask');
    expect(skill.manifest).toContain('cxx portal leave');
    expect(skill.manifest).toMatch(/unacknowledged\s+lease is deliberately redelivered/);
    expect(skill.manifest).toMatch(/Never POST to Matrix yourself/);
    expect(skill.manifest).toMatch(/Matrix is only the\s+notification path/);
  });

  it('preserves the authority and output boundaries', () => {
    expect(skill.manifest).toMatch(/cannot approve, elevate, or broaden authority/);
    expect(skill.manifest).toMatch(/Never paste raw terminal output, secrets, hidden reasoning/);
    expect(skill.manifest).toMatch(/first portal answer wins/i);
  });

  it('is stable, engine-agnostic, and code-owned', () => {
    expect(skill.slug).toBe(MANAGED_AFK_SKILL_SLUG);
    expect(skill.engine).toBeNull();
    expect(skill.managed).toBe(true);
    expect(skill.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildManagedAfkSkill('later').sha256).toBe(skill.sha256);
    expect(isManagedAfkSlug(' AFK ')).toBe(true);
  });
});
