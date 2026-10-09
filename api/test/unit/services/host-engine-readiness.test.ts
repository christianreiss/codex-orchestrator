import { describe, it, expect } from 'vitest';
import type { Host } from '../../../src/db/schema.js';
import { ENGINES, ENGINE_HOST_FIELDS, type Engine } from '../../../src/util/engine.js';
import { hostEngineReadiness } from '../../../src/services/host-engine-readiness.js';
import type { VersionSnapshot } from '../../../src/services/version-snapshot.js';
function host(overrides: Partial<Host> = {}): Host {
  return { engines: 'codex,claude,grok', secure: 1,
    clientVersion: '1.2.3', claudeClientVersion: '1.2.3', grokClientVersion: '1.2.3',
    wrapperVersion: '0.9.40', claudeWrapperVersion: '0.9.40', grokWrapperVersion: '0.9.40',
    authDigest: 'old-codex-auth', claudeAuthDigest: 'old-claude-auth', grokAuthDigest: 'old-grok-auth',
    ...overrides } as Host;
}
function targets(overrides: Partial<VersionSnapshot> = {}): Record<Engine, VersionSnapshot> {
  return Object.fromEntries(ENGINES.map(engine => [engine, { engine, client_version: '1.2.3',
    client_version_override: null, client_version_enforce_exact: false,
    wrapper_version: '0.9.40', fleet_disabled_engines: [], ...overrides }])) as Record<Engine, VersionSnapshot>;
}
describe('per-engine host readiness', () => {
  for (const engine of ENGINES) {
    const fields = ENGINE_HOST_FIELDS[engine];
    it(`${engine}: existing auth is enough regardless of its age`, () => {
      expect(hostEngineReadiness(host(), targets())[engine]).toMatchObject({ state: 'ready', reasons: [] });
    });
    it(`${engine}: missing auth is yellow only for secure hosts`, () => {
      const missing = host({ [fields.authDigest]: null });
      expect(hostEngineReadiness(missing, targets())[engine]).toMatchObject({ state: 'attention', reasons: ['auth_missing'] });
      expect(hostEngineReadiness({ ...missing, secure: 0 }, targets())[engine].state).toBe('ready');
      for (const other of ENGINES.filter(e => e !== engine)) expect(hostEngineReadiness(missing, targets())[other].state).toBe('ready');
    });
    for (const secure of [0, 1]) it(`${engine}: outdated or unknown CLI/wrapper warns (secure=${secure})`, () => {
      for (const [field, prefix, outdated] of [[fields.clientVersion, 'cli', '1.0.0'], [fields.wrapperVersion, 'wrapper', '0.9.0']] as const) {
        for (const value of [outdated, null, 'unknown']) {
          const result = hostEngineReadiness(host({ secure, [field]: value }), targets())[engine];
          expect(result).toMatchObject({ state: 'attention', reasons: [`${prefix}_${value === outdated ? 'outdated' : 'unknown'}`] });
        }
      }
    });
    it(`${engine}: host pin overrides fleet pin and compares installed rather than configured version`, () => {
      const pinned = host({ [fields.clientVersionOverride]: '1.0.0', [fields.clientVersion]: 'v1.0.0' });
      expect(hostEngineReadiness(pinned, targets({ client_version_override: '1.1.0', client_version_enforce_exact: true }))[engine])
        .toMatchObject({ state: 'ready', cli_target: '1.0.0', cli_version: 'v1.0.0' });
      expect(hostEngineReadiness({ ...pinned, [fields.clientVersion]: '1.2.3' }, targets())[engine].reasons).toContain('cli_outdated');
    });
    it(`${engine}: fleet suspension and missing assignment are gray`, () => {
      expect(hostEngineReadiness(host(), targets({ fleet_disabled_engines: [engine] }))[engine])
        .toMatchObject({ state: 'inactive', reasons: ['fleet_disabled'] });
      expect(hostEngineReadiness(host({ engines: ENGINES.filter(e => e !== engine).join(',') }), targets())[engine])
        .toMatchObject({ state: 'inactive', reasons: ['not_assigned'] });
    });
  }
  it('minimum targets accept newer versions; exact targets reject them', () => {
    const newer = host({ clientVersion: '2.0.0', wrapperVersion: '0.10.0' });
    expect(hostEngineReadiness(newer, targets()).codex.state).toBe('ready');
    expect(hostEngineReadiness(newer, targets({ client_version_enforce_exact: true })).codex.reasons).toEqual(['cli_outdated']);
  });
  it('unknown targets never claim readiness', () => {
    expect(hostEngineReadiness(host(), targets({ client_version: null, wrapper_version: null })).codex)
      .toMatchObject({ state: 'attention', reasons: ['cli_unknown', 'wrapper_unknown'] });
  });
  it('normalizes prefixes and applies prerelease precedence and build metadata', () => {
    for (const [installed, target, state] of [
      ['codex-cli v1.2.3', '1.2.3', 'ready'], ['1.2.3-beta.2', '1.2.3-beta.10', 'attention'],
      ['1.2.3-beta.10', '1.2.3-beta.2', 'ready'], ['1.2.3-beta', '1.2.3', 'attention'],
      ['1.2.3', '1.2.3-beta', 'ready'], ['1.2.3+build.1', '1.2.3+build.2', 'ready'],
    ] as const) expect(hostEngineReadiness(host({ clientVersion: installed }), targets({ client_version: target })).codex.state).toBe(state);
  });
});
