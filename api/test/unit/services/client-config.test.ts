import { describe, expect, it } from 'vitest';
import { renderToml, renderTomlForHost } from '../../../src/services/client-config.js';
import { normalizeSettings } from '../../../src/services/config-normalizer.js';

describe('client-config: renderToml', () => {
  it('renders root scalars in the legacy order', () => {
    const s = normalizeSettings({
      model: 'gpt-5.4',
      profile: 'workhorse',
      personality: 'friendly',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      model_reasoning_effort: 'high',
    });
    const toml = renderToml(s);
    const lines = toml.split('\n');
    expect(lines[0]).toBe('model = "gpt-5.4"');
    expect(toml).toContain('profile = "workhorse"');
    expect(toml).toContain('personality = "friendly"');
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).toContain('model_reasoning_effort = "high"');
  });

  it('emits a [features] section sorted alphabetically', () => {
    const s = normalizeSettings({
      features: { zebra: true, apple: false, mango: true },
    });
    const toml = renderToml(s);
    const featuresIdx = toml.indexOf('[features]');
    expect(featuresIdx).toBeGreaterThan(-1);
    const after = toml.slice(featuresIdx);
    const appleIdx = after.indexOf('apple');
    const mangoIdx = after.indexOf('mango');
    const zebraIdx = after.indexOf('zebra');
    expect(appleIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it('emits [security] only when bypass flag is explicitly set', () => {
    const off = renderToml(normalizeSettings({ security: { dangerously_bypass_approvals_and_sandbox: false } }));
    expect(off).toContain('[security]');
    expect(off).toContain('dangerously_bypass_approvals_and_sandbox = false');
    const none = renderToml(normalizeSettings({}));
    expect(none).not.toContain('[security]');
  });

  it('emits named profile tables sorted by name', () => {
    const s = normalizeSettings({
      profiles: [
        { name: 'workhorse', model: 'gpt-5.4', model_reasoning_effort: 'high' },
        { name: 'fast', model: 'gpt-5.4-mini' },
      ],
    });
    const toml = renderToml(s);
    expect(toml).toContain('[profiles.fast]');
    expect(toml).toContain('[profiles.workhorse]');
    const workhorseIdx = toml.indexOf('[profiles.workhorse]');
    const fastIdx = toml.indexOf('[profiles.fast]');
    expect(workhorseIdx).toBeGreaterThan(-1);
    expect(fastIdx).toBeLessThan(workhorseIdx);
  });

  it('renders legacy xhigh profile effort as high', () => {
    const toml = renderToml(normalizeSettings({
      profiles: [
        { name: 'max', model: 'gpt-5.4', model_reasoning_effort: 'xhigh' },
      ],
    }));
    expect(toml).toContain('[profiles.max]');
    expect(toml).toContain('model_reasoning_effort = "high"');
    expect(toml).not.toContain('xhigh');
  });

  it('renders notify lists when present', () => {
    const s = normalizeSettings({ notify: ['mailto:a@b', 'webhook'] });
    const toml = renderToml(s);
    expect(toml).toContain('notify = ["mailto:a@b", "webhook"]');
  });

  it('escapes strings with quotes and newlines', () => {
    const s = normalizeSettings({ model: 'has "quotes" and\nnewline' });
    const toml = renderToml(s);
    expect(toml).toContain('model = "has \\"quotes\\" and\\nnewline"');
  });

  it('renders MCP servers as named Codex tables', () => {
    const s = normalizeSettings({
      mcp_servers: [
        {
          name: 'orchestrator',
          url: 'https://coord.example/mcp',
          http_headers: { Authorization: 'Bearer abc123' },
          startup_timeout_sec: 30,
        },
      ],
    });
    const toml = renderToml(s);
    expect(toml).toContain('[mcp_servers.orchestrator]');
    expect(toml).toContain('url = "https://coord.example/mcp"');
    expect(toml).toContain('http_headers = { Authorization = "Bearer abc123" }');
    expect(toml).toContain('startup_timeout_sec = 30');
  });

  it('bakes managed MCP and trusted project for a host', () => {
    const rendered = renderTomlForHost({
      settings: {
        mcp_servers: [
          { name: 'codex-memory', command: 'legacy-managed' },
          { name: 'user-custom', command: '/bin/echo' },
        ],
      },
      host: { id: 7, fqdn: 'host.example', secure: 1 } as never,
      baseUrl: 'https://coord.example/',
      apiKey: 'abc123',
      home: '/home/chris',
    });
    expect(rendered.content).toContain('[mcp_servers.cdx]');
    expect(rendered.content).toContain('url = "https://coord.example/mcp"');
    expect(rendered.content).toContain('http_headers = { Authorization = "Bearer abc123" }');
    expect(rendered.content).toContain('[mcp_servers.user-custom]');
    expect(rendered.content).not.toContain('codex-memory');
    expect(rendered.content).toContain('[projects."/home/chris"]');
    expect(rendered.content).toContain('trust_level = "trusted"');
  });

  it('injects BrowserOS MCP only when the Codex host toggle is enabled', () => {
    const rendered = renderTomlForHost({
      settings: {
        mcp_servers: [
          { name: 'browseros', url: 'http://old.example/mcp' },
          { name: 'user-custom', command: '/bin/echo' },
        ],
      },
      host: { id: 7, fqdn: 'host.example', secure: 1, browserosMcpEnabled: 1 } as never,
      baseUrl: 'https://coord.example/',
      apiKey: 'abc123',
      home: '/home/chris',
    });
    expect(rendered.content).toContain('[mcp_servers.browseros]');
    expect(rendered.content).toContain('url = "http://127.0.0.1:9000/mcp"');
    expect(rendered.content).toContain('startup_timeout_sec = 30');
    expect(rendered.content).not.toContain('http://old.example/mcp');
    expect(rendered.content).toContain('[mcp_servers.user-custom]');
  });
});
