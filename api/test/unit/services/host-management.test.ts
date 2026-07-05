import { describe, it, expect } from 'vitest';
import {
  parseEnginesInput,
  serializeEngines,
  installerModeForEngines,
  installerModeLabel,
  installerCommand,
  isSemanticVersion,
  normalizeSemver,
  clampInsecureMinutes,
  computeGraceUntil,
  MIN_INSECURE_WINDOW_MINUTES,
  MAX_INSECURE_WINDOW_MINUTES,
  DEFAULT_INSECURE_WINDOW_MINUTES,
} from '../../../src/services/host-management.js';
import { ENGINE_CODEX, ENGINE_CLAUDE } from '../../../src/util/engine.js';
import {
  parseReverseDnsModeInput,
  modeStringToTinyint,
  tinyintToModeString,
  normalizeHostname,
  normalizeIp,
} from '../../../src/services/reverse-dns.js';

describe('host-management pure helpers', () => {
  describe('parseEnginesInput', () => {
    it('parses comma-separated strings into canonical engine list', () => {
      expect(parseEnginesInput('codex,claude', [ENGINE_CODEX])).toEqual([
        ENGINE_CODEX,
        ENGINE_CLAUDE,
      ]);
      expect(parseEnginesInput('claude', [ENGINE_CODEX])).toEqual([ENGINE_CLAUDE]);
      expect(parseEnginesInput('codex', [ENGINE_CODEX])).toEqual([ENGINE_CODEX]);
    });
    it('accepts arrays and dedupes case-insensitively', () => {
      expect(parseEnginesInput(['Codex', 'codex', 'claude'], [ENGINE_CODEX])).toEqual([
        ENGINE_CODEX,
        ENGINE_CLAUDE,
      ]);
    });
    it('ignores invalid engine names', () => {
      expect(parseEnginesInput('codex,llama,claude,grok', [ENGINE_CODEX])).toEqual([
        ENGINE_CODEX,
        ENGINE_CLAUDE,
      ]);
    });
    it('falls back when nothing valid', () => {
      expect(parseEnginesInput('llama', [ENGINE_CLAUDE])).toEqual([]);
    });
    it('falls back on null/undefined', () => {
      expect(parseEnginesInput(undefined, [ENGINE_CODEX])).toEqual([ENGINE_CODEX]);
      expect(parseEnginesInput(null, [])).toEqual([ENGINE_CODEX]);
    });
  });

  describe('serializeEngines / installerModeForEngines', () => {
    it('canonicalizes serialize order: codex,claude', () => {
      expect(serializeEngines([ENGINE_CLAUDE, ENGINE_CODEX])).toBe('codex,claude');
      expect(serializeEngines([ENGINE_CODEX])).toBe('codex');
      expect(serializeEngines([ENGINE_CLAUDE])).toBe('claude');
      expect(serializeEngines([])).toBe('codex');
    });
    it('classifies installer mode', () => {
      expect(installerModeForEngines([ENGINE_CODEX])).toBe('codex');
      expect(installerModeForEngines([ENGINE_CLAUDE])).toBe('claude');
      expect(installerModeForEngines([ENGINE_CLAUDE, ENGINE_CODEX])).toBe('both');
    });
    it('labels installer modes', () => {
      expect(installerModeLabel('codex')).toBe('Codex');
      expect(installerModeLabel('claude')).toBe('Claude');
      expect(installerModeLabel('both')).toBe('Codex + Claude');
    });
    it('adds curl -k and installer env for curl-insecure hosts', () => {
      const url = 'https://orch.example.com/install/tok';
      expect(installerCommand(url, false)).toBe(`curl -fsSL ${url} | sh`);
      expect(installerCommand(url, true)).toBe(
        `curl -k -fsSL ${url} | CODEX_INSTALL_CURL_INSECURE=1 sh`,
      );
    });
  });

  describe('isSemanticVersion / normalizeSemver', () => {
    it('accepts X.Y.Z form', () => {
      expect(isSemanticVersion('0.125.0')).toBe(true);
      expect(isSemanticVersion('1.2.3')).toBe(true);
      expect(isSemanticVersion('10.20.30')).toBe(true);
    });
    it('accepts pre-release and build metadata', () => {
      expect(isSemanticVersion('1.2.3-rc1')).toBe(true);
      expect(isSemanticVersion('1.2.3+abc')).toBe(true);
      expect(isSemanticVersion('1.2.3-rc1.4')).toBe(true);
    });
    it('rejects non-versions', () => {
      expect(isSemanticVersion('global')).toBe(false);
      expect(isSemanticVersion('1.2')).toBe(false);
      expect(isSemanticVersion('')).toBe(false);
      expect(isSemanticVersion('latest')).toBe(false);
    });
    it('normalizes v-prefixed versions', () => {
      expect(normalizeSemver('v1.2.3')).toBe('1.2.3');
      expect(normalizeSemver(' V1.2.3 ')).toBe('1.2.3');
      expect(normalizeSemver('1.2.3')).toBe('1.2.3');
    });
  });

  describe('clampInsecureMinutes', () => {
    it('clamps below the minimum', () => {
      expect(clampInsecureMinutes(-10, 30)).toBe(MIN_INSECURE_WINDOW_MINUTES);
    });
    it('clamps above the maximum', () => {
      expect(clampInsecureMinutes(99999, 30)).toBe(MAX_INSECURE_WINDOW_MINUTES);
    });
    it('passes a valid value through', () => {
      expect(clampInsecureMinutes(30, DEFAULT_INSECURE_WINDOW_MINUTES)).toBe(30);
    });
    it('uses the fallback when value is non-finite', () => {
      expect(clampInsecureMinutes(Number.NaN, 7)).toBe(7);
      expect(clampInsecureMinutes(null, 9)).toBe(9);
      expect(clampInsecureMinutes(undefined, 11)).toBe(11);
    });
  });

  describe('computeGraceUntil', () => {
    it('returns null when no enabled-until', () => {
      expect(computeGraceUntil(null, 30, 60)).toBeNull();
    });
    it('returns null with zero window or zero grace', () => {
      const now = new Date();
      expect(computeGraceUntil(now, 0, 60)).toBeNull();
      expect(computeGraceUntil(now, 30, 0)).toBeNull();
    });
    it('adds graceMinutes to the enabled-until date', () => {
      const start = new Date('2024-01-01T00:00:00Z');
      const grace = computeGraceUntil(start, 30, 60);
      expect(grace?.toISOString()).toBe('2024-01-01T01:00:00.000Z');
    });
  });
});

describe('reverse-dns helpers', () => {
  it('parses tri-state mode input', () => {
    expect(parseReverseDnsModeInput('global')).toBe('global');
    expect(parseReverseDnsModeInput('')).toBe('global');
    expect(parseReverseDnsModeInput('default')).toBe('global');
    expect(parseReverseDnsModeInput('enabled')).toBe('enabled');
    expect(parseReverseDnsModeInput('disabled')).toBe('disabled');
    expect(parseReverseDnsModeInput(true)).toBe('enabled');
    expect(parseReverseDnsModeInput(false)).toBe('disabled');
    expect(parseReverseDnsModeInput(1)).toBe('enabled');
    expect(parseReverseDnsModeInput(0)).toBe('disabled');
    expect(parseReverseDnsModeInput('yes')).toBe('enabled');
    expect(parseReverseDnsModeInput('no')).toBe('disabled');
  });
  it('returns null for invalid mode input', () => {
    expect(parseReverseDnsModeInput('maybe')).toBeNull();
    expect(parseReverseDnsModeInput(2)).toBeNull();
    expect(parseReverseDnsModeInput({})).toBeNull();
  });
  it('round-trips mode <-> tinyint', () => {
    expect(modeStringToTinyint('global')).toBeNull();
    expect(modeStringToTinyint('enabled')).toBe(1);
    expect(modeStringToTinyint('disabled')).toBe(0);
    expect(tinyintToModeString(null)).toBe('global');
    expect(tinyintToModeString(undefined)).toBe('global');
    expect(tinyintToModeString(0)).toBe('disabled');
    expect(tinyintToModeString(1)).toBe('enabled');
  });
  it('normalizes hostnames', () => {
    expect(normalizeHostname('Example.COM.')).toBe('example.com');
    expect(normalizeHostname(' host.example. ')).toBe('host.example');
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
  });
  it('normalizes ipv4-mapped v6 addresses', () => {
    expect(normalizeIp('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeIp('192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBeNull();
  });
});
