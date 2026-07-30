import { describe, expect, it } from 'vitest';
import {
  MANAGED_AFK_SKILL_SLUG,
  buildManagedAfkSkill,
  isManagedAfkSlug,
} from '../../../src/services/managed-afk-skill.js';

describe('managed #afk portal skill', () => {
  const skill = buildManagedAfkSkill('2026-07-29T00:00:00Z');

  it('uses the scoped relay and names the portal as the only channel', () => {
    expect(skill.manifest).toContain('cxx portal notify');
    expect(skill.manifest).toContain('cxx portal wait');
    expect(skill.manifest).toContain('cxx portal accept');
    expect(skill.manifest).toContain('cxx portal say');
    expect(skill.manifest).toContain('cxx portal ask');
    expect(skill.manifest).toContain('cxx portal leave');
    expect(skill.manifest).toMatch(/unacknowledged\s+lease is deliberately redelivered/);
    // The portal replaced an outbound Matrix fan-out. The manifest must not
    // reintroduce it by suggesting the agent notify anyone directly, and must
    // not treat the permanent link as something an agent may hand out.
    expect(skill.manifest).not.toMatch(/matrix/i);
    expect(skill.manifest).toMatch(/Never send this notice anywhere yourself/);
    expect(skill.manifest).toMatch(/The portal\s+is the only sanctioned channel/);
    expect(skill.manifest).toMatch(/Never read, request, print, or store a portal link/);
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
