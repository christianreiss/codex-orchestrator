import { describe, it, expect } from 'vitest';
import {
  fingerprint,
  maskSecret,
  toDto,
  EMPTY_CONFIG,
  type JoplinConfig,
} from '../../../src/services/joplin-config.js';

describe('joplin-config', () => {
  describe('fingerprint', () => {
    it('returns null when any required field is missing', () => {
      expect(fingerprint({ url: '', email: 'a@b', password: 'pw' })).toBeNull();
      expect(fingerprint({ url: 'https://x', email: '', password: 'pw' })).toBeNull();
      expect(fingerprint({ url: 'https://x', email: 'a@b', password: '' })).toBeNull();
    });

    it('produces a stable sha256 for the same inputs', () => {
      const a = fingerprint({ url: 'https://x', email: 'a@b', password: 'pw' });
      const b = fingerprint({ url: 'https://x', email: 'a@b', password: 'pw' });
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes when any input changes', () => {
      const a = fingerprint({ url: 'https://x', email: 'a@b', password: 'pw' });
      const b = fingerprint({ url: 'https://y', email: 'a@b', password: 'pw' });
      expect(a).not.toBe(b);
    });

    it('normalises trailing slashes on URL', () => {
      const a = fingerprint({ url: 'https://x/', email: 'a@b', password: 'pw' });
      const b = fingerprint({ url: 'https://x', email: 'a@b', password: 'pw' });
      expect(a).toBe(b);
    });
  });

  describe('maskSecret', () => {
    it('masks short values fully', () => {
      expect(maskSecret('')).toBe('');
      expect(maskSecret('abc')).toBe('****');
      expect(maskSecret('  ')).toBe('');
    });

    it('keeps the last four characters for longer values', () => {
      expect(maskSecret('supersecrettoken')).toBe('…oken');
    });
  });

  describe('toDto', () => {
    it('returns sensible defaults for the empty config', () => {
      const dto = toDto({ ...EMPTY_CONFIG });
      expect(dto.enabled).toBe(false);
      expect(dto.url).toBe('');
      expect(dto.password_set).toBe(false);
      expect(dto.config_complete).toBe(false);
      expect(dto.verified_connection).toBe(false);
      expect(dto.can_activate).toBe(false);
      expect(dto.activation_reason).toBe('missing_url');
    });

    it('marks the config as verified when the fingerprint matches', () => {
      const config: JoplinConfig = {
        url: 'https://j.example',
        email: 'me@example.com',
        password: 'pw',
        enabled: false,
        syncIntervalMinutes: 30,
        verifiedAt: '2026-01-01T00:00:00Z',
        verifiedFingerprint: null,
      };
      config.verifiedFingerprint = fingerprint(config);
      const dto = toDto(config);
      expect(dto.config_complete).toBe(true);
      expect(dto.verified_connection).toBe(true);
      expect(dto.can_activate).toBe(true);
      expect(dto.activation_reason).toBe('ready');
      // The password itself never leaks
      expect(JSON.stringify(dto)).not.toContain('pw');
      expect(dto.password_hint).toMatch(/^\*{4}|^…/);
    });

    it('invalidates verification once the fingerprint changes', () => {
      const original: JoplinConfig = {
        url: 'https://j.example',
        email: 'me@example.com',
        password: 'pw',
        enabled: false,
        syncIntervalMinutes: 30,
        verifiedAt: '2026-01-01T00:00:00Z',
        verifiedFingerprint: null,
      };
      original.verifiedFingerprint = fingerprint(original);
      const tampered: JoplinConfig = { ...original, password: 'different' };
      expect(toDto(tampered).verified_connection).toBe(false);
    });

    it('reports the activation reason for each missing piece', () => {
      const base: JoplinConfig = { ...EMPTY_CONFIG };
      expect(toDto(base).activation_reason).toBe('missing_url');
      expect(toDto({ ...base, url: 'https://x' }).activation_reason).toBe('missing_email');
      expect(
        toDto({ ...base, url: 'https://x', email: 'a@b' }).activation_reason,
      ).toBe('missing_password');
      expect(
        toDto({
          ...base,
          url: 'https://x',
          email: 'a@b',
          password: 'pw',
          syncIntervalMinutes: 0,
        }).activation_reason,
      ).toBe('invalid_interval');
      expect(
        toDto({
          ...base,
          url: 'https://x',
          email: 'a@b',
          password: 'pw',
          syncIntervalMinutes: 30,
        }).activation_reason,
      ).toBe('verification_required');
    });
  });
});
