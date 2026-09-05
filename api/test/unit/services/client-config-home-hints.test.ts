import { describe, expect, it } from 'vitest';
import {
  renderClaudeSettingsPartialForHost,
  renderTomlForHost,
} from '../../../src/services/client-config.js';
import { ENGINE_CLAUDE, ENGINE_CODEX } from '../../../src/util/engine.js';

const HOST = { id: 7, fqdn: 'host.example', secure: 1 } as never;

const CLAUDE_OPTS = {
  settings: {
    model: 'claude-opus-4-7',
    effortLevel: 'xhigh',
    mcp_servers: [{ name: 'user-custom', command: '/bin/echo' }],
  },
  host: HOST,
  baseUrl: 'https://coord.example/',
  apiKey: 'abc123',
  engine: ENGINE_CLAUDE,
};

const CODEX_OPTS = {
  settings: {
    model: 'gpt-6-astra',
    mcp_servers: [{ name: 'user-custom', command: '/bin/echo' }],
  },
  host: HOST,
  baseUrl: 'https://coord.example/',
  apiKey: 'abc123',
  engine: ENGINE_CODEX,
};

describe('client-config: home/username hints are Claude-invariant', () => {
  it('renders byte-identical config for engine=claude with and without the hints', () => {
    const bare = renderTomlForHost(CLAUDE_OPTS);
    const hinted = renderTomlForHost({ ...CLAUDE_OPTS, home: '/home/chris', username: 'chris' });

    expect(hinted.content).toBe(bare.content);
    expect(hinted.sha256).toBe(bare.sha256);
    expect(hinted.content).not.toContain('trust_level');
    expect(hinted.content).not.toContain('/home/chris');

    // username-only (the server derives /home/<user> from it for codex) is inert too.
    const userOnly = renderTomlForHost({ ...CLAUDE_OPTS, username: 'chris' });
    expect(userOnly.content).toBe(bare.content);
    expect(userOnly.sha256).toBe(bare.sha256);
  });

  it('renders an invariant partial/owned_paths/sha256 for the deep-merge path', () => {
    const bare = renderClaudeSettingsPartialForHost(CLAUDE_OPTS);
    const hinted = renderClaudeSettingsPartialForHost({
      ...CLAUDE_OPTS,
      home: '/home/chris',
      username: 'chris',
    });

    expect(hinted.partial).toEqual(bare.partial);
    expect(hinted.owned_paths).toEqual(bare.owned_paths);
    expect(hinted.sha256).toBe(bare.sha256);
    expect(JSON.stringify(hinted.partial)).not.toContain('trust_level');
    expect(hinted.owned_paths).not.toContain('projects');
  });

  it('bakes the trusted project stanza for engine=codex, changing the sha', () => {
    const bare = renderTomlForHost(CODEX_OPTS);
    const hinted = renderTomlForHost({ ...CODEX_OPTS, home: '/home/chris' });

    expect(bare.content).not.toContain('trust_level');
    expect(hinted.content).toContain('[projects."/home/chris"]');
    expect(hinted.content).toContain('trust_level = "trusted"');
    expect(hinted.sha256).not.toBe(bare.sha256);

    const fromUsername = renderTomlForHost({ ...CODEX_OPTS, username: 'chris' });
    expect(fromUsername.content).toContain('[projects."/home/chris"]');
    expect(fromUsername.sha256).toBe(hinted.sha256);
  });
});
