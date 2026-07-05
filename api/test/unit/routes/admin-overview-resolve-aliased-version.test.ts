import { describe, expect, it } from 'vitest';
import { resolveAliasedVersion } from '../../../src/routes/admin/overview/index.js';

describe('resolveAliasedVersion', () => {
  it('resolves the "latest" policy alias to the concrete cached upstream version', () => {
    expect(resolveAliasedVersion('latest', { version: '0.142.5' })).toBe('0.142.5');
  });

  it('resolves the "auto" alias too, case- and whitespace-insensitively', () => {
    expect(resolveAliasedVersion('  Auto  ', { version: '2.1.201' })).toBe('2.1.201');
  });

  it('falls back to the raw alias string when no cached upstream release is available', () => {
    expect(resolveAliasedVersion('latest', null)).toBe('latest');
  });

  it('passes through a concrete version unchanged', () => {
    expect(resolveAliasedVersion('0.142.5', { version: '0.150.0' })).toBe('0.142.5');
  });

  it('passes through null unchanged', () => {
    expect(resolveAliasedVersion(null, { version: '0.142.5' })).toBeNull();
  });
});
