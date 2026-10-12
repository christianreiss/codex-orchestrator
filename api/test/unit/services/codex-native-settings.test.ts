import { describe, expect, it } from 'vitest';
import { normalizeSettings, normalizeApprovalPolicy } from '../../../src/services/config-normalizer.js';
import { normalizeCodexNativeSettings } from '../../../src/services/codex-native-settings.js';
import { ClientConfigService, renderToml, renderTomlForHost } from '../../../src/services/client-config.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { clientConfigDocuments } from '../../../src/db/schema.js';
import { ModelDefaultsService } from '../../../src/services/model-defaults.js';
import { presetLevels } from '../../../src/services/agent-security-levels.js';

const native = {
  service_tier: 'priority', approvals_reviewer: 'auto_review',
  agents: { max_concurrent_threads_per_session: 4, enabled: true, reviewer: { description: 'Review', config_file: '/tmp/reviewer.toml' } },
  apps: { _default: { enabled: false }, calendar: { enabled: true, tools: { read_event: { approval_mode: 'prompt' } } } },
  tui: { theme: 'github-light', terminal_title: ['project'], vim_mode_default: true },
  history: { persistence: 'none' },
  features: { rollout_budget: { enabled: true, limit_tokens: 25000, prefill_token_weight: 0.1, reminder_at_remaining_tokens: [5000] }, hooks: true },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done', timeout: 10 }] }] },
  mcp_servers: {
    custom: { command: '/bin/echo', args: ['ready'], cwd: '/tmp', env: { HELLO: 'world' }, enabled_tools: ['read'], tools: { read: { approval_mode: 'prompt' } } },
    remote: { url: 'https://example.test/mcp', oauth: { client_id: 'audit-client' }, oauth_resource: 'audit-resource' },
  },
  shell_environment_policy: { filters: { '*SECRET*': 'exclude' }, experimental_use_profile: false },
};
const render = (settings: Record<string, unknown>) => renderTomlForHost({ settings, host: null, baseUrl: null, apiKey: null });

describe('Codex native configuration', () => {
  it('preserves official nested settings across normalization and rendering', () => {
    const settings = normalizeSettings({ native_settings: native });
    expect(settings.native_settings).toEqual(native);
    expect(normalizeSettings(settings).native_settings).toEqual(native);
    const result = render(settings as unknown as Record<string, unknown>);
    for (const text of ['service_tier = "priority"', '[agents.reviewer]', '[features.rollout_budget]', 'limit_tokens = 25000', '[[hooks.Stop.hooks]]', '[mcp_servers.custom.env]', 'HELLO = "world"', '[mcp_servers.remote.oauth]', '[shell_environment_policy.filters]']) expect(result.content).toContain(text);
    expect(result.content).not.toContain('native_settings');
  });

  it('does not let empty legacy defaults erase native values', () => {
    const settings = normalizeSettings({ native_settings: { model_provider: 'openai', notify: ['/bin/echo'], mcp_servers: native.mcp_servers }, model: null, notify: [], mcp_servers: [] });
    expect(settings.model_provider).toBeNull();
    expect(settings.notify).toEqual([]);
    expect(settings.mcp_servers).toHaveLength(0);
    expect(renderToml(settings)).toContain('model_provider = "openai"');
    expect(renderToml(settings)).toContain('notify = ["/bin/echo"]');
  });

  it('applies structured controls while preserving unrelated nested fields', () => {
    const result = render({ native_settings: native, model: 'gpt-6-luna', mcp_servers: [{ name: 'custom', args: ['override'] }] });
    for (const text of ['model = "gpt-6-luna"', 'args = ["override"]', 'HELLO = "world"']) expect(result.content).toContain(text);
  });

  it('validates the combined native and explicit structured configuration', () => {
    expect(() => render({ native_settings: native, features: { rollout_budget: { limit_tokens: 'invalid' } } })).toThrow();
  });

  it('preserves granular prompt categories', () => {
    const approval = { granular: { rules: true, sandbox_approval: false, mcp_elicitations: true, request_permissions: false, skill_approval: true } };
    expect(normalizeApprovalPolicy(approval)).toEqual(approval);
    const result = render({ native_settings: { approval_policy: approval } });
    expect(result.content).toContain('[approval_policy.granular]');
    expect(result.content).toContain('skill_approval = true');
  });

  it('keeps host posture ahead of native profiles and reviewers', () => {
    const result = renderTomlForHost({ settings: { native_settings: { approval_policy: 'never', approvals_reviewer: 'auto_review', default_permissions: 'wide', permissions: { wide: {} } } }, securityLevels: presetLevels('contained'), host: null, baseUrl: null, apiKey: null });
    expect(result.content).toContain('approval_policy = "on-request"');
    expect(result.content).toContain('approvals_reviewer = "user"');
    expect(result.content).not.toContain('default_permissions');
    expect(result.content).toContain('[permissions.wide]');
  });

  it('replaces conflicting managed MCP and keeps custom servers/skills', () => {
    const result = renderTomlForHost({ settings: { native_settings: { mcp_servers: { ...native.mcp_servers, cdx: { url: 'https://wrong.test/' } }, skills: { config: [{ name: 'audit', enabled: true }] } } }, host: { clientVersion: '0.162.1', id: 1, fqdn: 'test.example', secure: 1 } as never, baseUrl: 'https://fleet.test/', apiKey: 'test-key', home: '/home/test' });
    for (const text of ['url = "https://fleet.test/mcp"', '[mcp_servers.custom.env]', '[[skills.config]]', 'name = "skill-creator"', '[projects."/home/test"]']) expect(result.content).toContain(text);
    expect(result.content).not.toContain('wrong.test');
  });

  it.each([{ config: [] }, { config: [{ name: 'skill-creator', enabled: true }] }])('renders managed skill policy as one table for native config %j', ({ config }) => {
    const result = renderTomlForHost({ settings: { native_settings: { skills: { config } } }, host: { clientVersion: '0.162.1', id: 1, fqdn: 'test.example', secure: 1 } as never, baseUrl: 'https://fleet.test/', apiKey: 'test-key' });
    expect(result.content).not.toContain('config = []');
    expect(result.content.match(/name = "skill-creator"/g)).toHaveLength(1);
    expect(result.content).toContain('enabled = false');
  });

  it('renders complete modern profile sidecars', () => {
    const result = render({ native_settings: {}, profiles: [{ name: 'audit', native_settings: { ...native, sandbox_workspace_write: { writable_roots: ['/tmp/audit'] }, model_context_window: 100000 } }] });
    expect(result.content).not.toContain('[profiles');
    expect(result.profiles).toHaveLength(1);
    for (const text of ['[mcp_servers.custom.env]', 'model_context_window = 100000', 'writable_roots = ["/tmp/audit"]']) expect(result.profiles?.[0]?.content).toContain(text);
  });

  it('keeps host-owned policy in native profile sidecars', () => {
    const result = renderTomlForHost({ settings: { profiles: [{ name: 'audit', native_settings: { approval_policy: 'never', default_permissions: 'wide', permissions: { wide: {} }, skills: { config: [] }, mcp_servers: { cdx: { url: 'https://wrong.test/' } } } }] },
      host: { clientVersion: '0.162.1', id: 1, fqdn: 'test.example', secure: 1 } as never, baseUrl: 'https://fleet.test/', apiKey: 'test-key', securityLevels: presetLevels('contained'), home: '/home/test' });
    const body = result.profiles?.[0]?.content;
    expect(body).toContain('approval_policy = "on-request"');
    expect(body).toContain('url = "https://fleet.test/mcp"');
    expect(body).toContain('name = "skill-creator"');
    expect(body).toContain('[projects."/home/test"]');
    expect(body).not.toMatch(/wrong.test|default_permissions|config = \[\]/);
  });

  it.each([
    [], { model: 'gpt-6-luna' }, { model_reasoning_effort: 'high' }, { unknown_setting: true }, { tui: { unknown_setting: true } },
    { agents: { max_concurrent_threads_per_session: 0 } }, { features: { rollout_budget: { limit_tokens: 'many' } } },
    { features: { rollout_budget: { enabled: true, limit_tokens: 100 } } },
    { features: { apply_patch_preserve_line_endings: true } }, { features: { transcript_v2: true } }, { features: { use_legacy_landlock: true } },
    { features: { codex_hooks: true } }, { features: { guardianv2: { thread_context: true } } },
    { approval_policy: 'on-failure' }, { personality: 'friendly' }, { profile: 'old' }, { profiles: { old: {} } },
    { model_providers: { custom: { wire_api: 'chat' } } }, JSON.parse('{"apps":{"__proto__":{"polluted":true}}}'),
  ])('rejects invalid or deprecated input: %j', input => { expect(() => normalizeCodexNativeSettings(input)).toThrow(); });

  it('does not expose invalid setting values in errors', () => {
    expect(() => normalizeCodexNativeSettings({ approval_policy: 'secret-value' })).toThrow(/native_settings.approval_policy/);
    try { normalizeCodexNativeSettings({ approval_policy: 'secret-value' }); } catch (error) { expect(String(error)).not.toContain('secret-value'); }
  });

  it('migrates legacy values without emitting deprecated settings', () => {
    const result = render({ approval_policy: 'on-failure', personality: 'friendly', features: { web_search_request: true, codex_hooks: true, transcript_v2: true, use_legacy_landlock: true } });
    for (const text of ['approval_policy = "on-request"', 'web_search = "live"', 'hooks = true']) expect(result.content).toContain(text);
    expect(result.content).not.toMatch(/personality|codex_hooks|transcript_v2|use_legacy_landlock|on-failure/);
  });

  it('does not validate another engine with the Codex schema', () => {
    expect(() => normalizeSettings({ native_settings: { language: 'english' } }, { applyCodexDefaults: false, engine: 'claude' })).not.toThrow();
    expect(() => normalizeSettings({ native_settings: { models: {} } }, { applyCodexDefaults: false, engine: 'grok' })).not.toThrow();
  });

  it('persists native settings across store/fetch and later model-default updates', async () => {
    const db = createDbFake();
    const service = new ClientConfigService(db as never);
    const stored = await service.store({ settings: { native_settings: native } });
    expect(stored.settings.native_settings).toEqual(native);
    expect((await service.adminFetch()).settings?.native_settings).toEqual(native);
    await new ModelDefaultsService(db as never).set('codex', { model: 'gpt-6-luna', reasoning_effort: 'high' });
    const row = db.tables.get(clientConfigDocuments)?.at(-1);
    expect((row?.settings as Record<string, unknown>).native_settings).toEqual(native);
    expect(row?.body).toContain('[apps.calendar.tools.read_event]');
    expect(row?.body).toContain('model = "gpt-6-luna"');
  });

  it('keeps native edit/removal authoritative after store and fetch', async () => {
    const service = new ClientConfigService(createDbFake() as never);
    await service.store({ settings: { native_settings: { ...native, model_provider: 'openai', notify: ['/bin/old'] }, profiles: [{ name: 'audit', native_settings: { notify: ['/bin/old-profile'] } }] } });
    const fetched = (await service.adminFetch()).settings!;
    expect(fetched.mcp_servers).toEqual([]);
    expect(fetched.features).toEqual({});
    expect(fetched.shell_environment_policy).toEqual({});
    expect(fetched.model_provider).toBeNull();
    expect(fetched.notify).toEqual([]);
    fetched.native_settings = { ...fetched.native_settings, notify: ['/bin/new'], model_provider: 'new-provider',
      features: { hooks: false }, shell_environment_policy: { filters: { '*SECRET*': 'include' } },
      mcp_servers: { custom: { command: '/bin/updated' } },
    };
    fetched.profiles[0]!.native_settings = { notify: ['/bin/new-profile'] };
    const edited = await service.store({ settings: fetched });
    for (const text of ['notify = ["/bin/new"]', 'model_provider = "new-provider"', 'command = "/bin/updated"', 'hooks = false', '"*SECRET*" = "include"']) expect(edited.content).toContain(text);
    expect(edited.content).not.toMatch(/\/bin\/old|HELLO|ready|oauth_resource|rollout_budget|mcp_servers.remote/);
    expect(render(edited.settings as unknown as Record<string, unknown>).profiles?.[0]?.content).toContain('/bin/new-profile');
    const cleared = (await service.adminFetch()).settings!;
    cleared.native_settings = {};
    cleared.profiles[0]!.native_settings = {};
    const deleted = await service.store({ settings: cleared });
    expect(deleted.content).not.toMatch(/notify|model_provider|mcp_servers|shell_environment_policy|\[features/);
    expect(render(deleted.settings as unknown as Record<string, unknown>).profiles?.[0]?.content).not.toContain('/bin/');
  });

  it('preserves native settings through the service render entry point', () => {
    const result = new ClientConfigService({} as never).render({ native_settings: native });
    expect(result.settings.native_settings).toEqual(native);
    expect(result.content).toContain('[apps.calendar.tools.read_event]');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
