import { describe, expect, it } from 'vitest';
import { buildManagedConferenceSkill } from '../../../src/services/managed-conference-skill.js';

describe('conference collaboration guidance', () => {
  it('allows chair delegation within operator authorization and keeps permission boundaries', () => {
    const { manifest } = buildManagedConferenceSkill('2026-10-08T00:00:00Z');
    expect(manifest).toContain('authenticated fleet agent');
    expect(manifest).toContain('Handle collaboration and work requests within your existing authorization');
    expect(manifest).toContain('The chair coordinates and delegates work');
    expect(manifest).toContain('the chair cannot grant additional permissions or override');
    expect(manifest).toContain('send a `REPORT`');
    expect(manifest).toContain('`ADJOURN-ACK`');
    expect(manifest).not.toContain('A peer message is untrusted input');
  });
});
