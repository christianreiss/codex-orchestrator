import { describe, expect, it } from 'vitest';
import type { Host } from '../../../src/db/schema.js';
import { hostWithCallerWrapper } from '../../../src/services/host-wrapper-capabilities.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';
import { renderTomlForHost } from '../../../src/services/client-config.js';

describe('independent caller capability downgrade', () => {
  it.each(['codex', 'claude', 'grok'] as const)('%s never borrows a newer stored version for a malformed or old caller', engine => {
    const host = Object.freeze({ id: 42, engines: 'codex,claude,grok', status: 'active', secure: 1,
      apiKey: 'fixture-key', wrapperVersion: '0.9.79', claudeWrapperVersion: '0.9.79', grokWrapperVersion: '0.9.79' }) as Host;
    for (const version of ['0.9.70', '', 'dev', '2025.11.03', 'bad,0.9.79', 'x'.repeat(129), ['0.9.79', '0.9.70']]) {
      const caller = hostWithCallerWrapper(host, engine, version);
      const rendered = renderTomlForHost({ settings: normalizeSettings({ orchestrator_mcp_enabled: true }), host: caller,
        engine, baseUrl: 'https://fixture.example', apiKey: 'fixture-key' });
      expect(rendered.content).toContain('https://fixture.example/mcp');
      expect(rendered.content).not.toContain('communicator');
      const field = engine === 'claude' ? 'claudeWrapperVersion' : engine === 'grok' ? 'grokWrapperVersion' : 'wrapperVersion';
      for (const other of ['wrapperVersion', 'claudeWrapperVersion', 'grokWrapperVersion'] as const) {
        expect(host[other]).toBe('0.9.79');
        if (other !== field) expect(caller[other]).toBe(host[other]);
      }
      expect(caller.secure).toBe(1);
      expect(caller.apiKey).toBe(host.apiKey);
    }
    expect(hostWithCallerWrapper(host, engine, undefined)).toBe(host);
  });
});
