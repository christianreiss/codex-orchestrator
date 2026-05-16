import { describe, it, expect } from 'vitest';
import { isSemanticVersion, normalizeVersion } from '../../../src/services/client-versions.js';

describe('client-versions helpers', () => {
  it('accepts dotted semantic versions', () => {
    expect(isSemanticVersion('0.125.0')).toBe(true);
    expect(isSemanticVersion('1.2.3')).toBe(true);
    expect(isSemanticVersion('1.2.3-rc.1')).toBe(true);
  });

  it('rejects non-semver strings', () => {
    expect(isSemanticVersion('latest')).toBe(false);
    expect(isSemanticVersion('v1.2')).toBe(false);
    expect(isSemanticVersion('1.2')).toBe(false);
  });

  it('normalizes version strings by stripping leading v', () => {
    expect(normalizeVersion('v0.125.0')).toBe('0.125.0');
    expect(normalizeVersion('0.125.0')).toBe('0.125.0');
    expect(normalizeVersion('  v1.0.0  ')).toBe('1.0.0');
    expect(normalizeVersion(null)).toBeNull();
    expect(normalizeVersion('')).toBeNull();
  });
});
