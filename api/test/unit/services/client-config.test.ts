import { describe, expect, it } from 'vitest';
import {
  applyPostureToSettings,
  clampClaudePermissionModeForUser,
  injectManagedCodexSkillPolicyToml,
  renderClaudeSettingsPartial,
  renderClaudeSettingsPartialForHost,
  renderToml,
  renderTomlForHost,
} from '../../../src/services/client-config.js';
import { DEFAULT_CLAUDE_PERMISSION_MODE, normalizeSettings } from '../../../src/services/config-normalizer.js';
import { ENGINE_CLAUDE } from '../../../src/util/engine.js';
import { presetLevels } from '../../../src/services/agent-security-levels.js';

describe('client-config: renderToml', () => {
  it('renders root scalars in the legacy order', () => {
    const s = normalizeSettings({
      model: 'gpt-5.5',
      profile: 'workhorse',
      personality: 'friendly',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      model_reasoning_effort: 'high',
    });
    const toml = renderToml(s);
    const lines = toml.split('\n');
    expect(lines[0]).toBe('model = "gpt-5.5"');
    expect(toml).toContain('personality = "friendly"');
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).toContain('model_reasoning_effort = "high"');
  });

  it('never renders a top-level `profile` key: codex-cli 0.156.1+ treats it as a hard boot error', () => {
    // "legacy `profile = "code"` config is no longer supported; use `--profile
    // code` with `code.config.toml` instead" — confirmed live, 2026-09-23.
    // `settings.profile` is still normalized (applyHostModelOverrides in
    // client-config.ts routes host model overrides onto profiles by name), it
    // must just never reach the rendered TOML.
    const s = normalizeSettings({ model: 'gpt-5.5', profile: 'workhorse' });
    expect(s.profile).toBe('workhorse');
    const toml = renderToml(s);
    expect(toml).not.toMatch(/^profile\s*=/m);
  });

  it('renders `local_provider` under its codex-cli 0.156.1 name `oss_provider`', () => {
    const s = normalizeSettings({ model: 'gpt-5.5', local_provider: 'ollama' });
    const toml = renderToml(s);
    expect(toml).toContain('oss_provider = "ollama"');
    expect(toml).not.toMatch(/^local_provider\s*=/m);
  });

  it('drops model_supports_reasoning_summaries and model_max_output_tokens: codex-cli ignores both everywhere', () => {
    const s = normalizeSettings({
      model: 'gpt-5.5',
      model_supports_reasoning_summaries: true,
      model_max_output_tokens: 4096,
      model_context_window: 128000,
    });
    const toml = renderToml(s);
    expect(toml).not.toMatch(/model_supports_reasoning_summaries/);
    expect(toml).not.toMatch(/model_max_output_tokens/);
    // model_context_window is still valid at top level — only per-profile is dropped.
    expect(toml).toContain('model_context_window = 128000');
  });

  it('drops the dead [security] table entirely', () => {
    const s = normalizeSettings({
      model: 'gpt-5.5',
      security: { dangerously_bypass_approvals_and_sandbox: true },
    });
    const toml = renderToml(s);
    expect(toml).not.toContain('[security]');
    expect(toml).not.toContain('dangerously_bypass_approvals_and_sandbox');
  });

  it('per-profile: drops model_context_window and the sandbox_workspace_write table', () => {
    const s = normalizeSettings({
      model: 'gpt-5.5',
      profiles: [
        {
          name: 'code',
          model_context_window: 128000,
          sandbox_workspace_write: { network_access: true },
        },
      ],
    });
    const toml = renderToml(s);
    const profileIdx = toml.indexOf('[profiles.code]');
    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(toml).not.toContain('[profiles.code.sandbox_workspace_write]');
    expect(toml.slice(profileIdx)).not.toMatch(/model_context_window/);
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

  it('never emits [security]: codex-cli 0.156.1 reports the whole table ignored', () => {
    // The bypass flag is still normalized/stored (ingest back-compat and the
    // dedicated "drops the dead [security] table entirely" test above), but
    // was never a real render/no-render distinction to begin with — neither
    // value should reach the TOML.
    const off = renderToml(normalizeSettings({ security: { dangerously_bypass_approvals_and_sandbox: false } }));
    expect(off).not.toContain('[security]');
    const on = renderToml(normalizeSettings({ security: { dangerously_bypass_approvals_and_sandbox: true } }));
    expect(on).not.toContain('[security]');
    const none = renderToml(normalizeSettings({}));
    expect(none).not.toContain('[security]');
  });

  it('emits named profile tables sorted by name', () => {
    const s = normalizeSettings({
      profiles: [
        { name: 'workhorse', model: 'gpt-5.5', model_reasoning_effort: 'high' },
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

  it('renders the Terra xhigh profile effort verbatim', () => {
    const toml = renderToml(normalizeSettings({
      profiles: [
        { name: 'max', model: 'gpt-5.6-terra', model_reasoning_effort: 'xhigh' },
      ],
    }));
    expect(toml).toContain('[profiles.max]');
    expect(toml).toContain('model_reasoning_effort = "xhigh"');
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
    expect(rendered.content).toContain('Authorization = "Bearer abc123"');
    expect(rendered.content).toContain('X-Engine = "codex"');
    expect(rendered.content).toContain('[mcp_servers.user-custom]');
    expect(rendered.content).not.toContain('codex-memory');
    expect(rendered.content).toContain('[[skills.config]]');
    expect(rendered.content).toContain('name = "skill-creator"');
    expect(rendered.content).toContain('enabled = false');
    expect(rendered.content).toContain('[projects."/home/chris"]');
    expect(rendered.content).toContain('trust_level = "trusted"');
  });

  it('disables the local creator only when managed Codex MCP is usable', () => {
    const mcpDisabled = renderTomlForHost({
      settings: { orchestrator_mcp_enabled: false },
      host: { id: 7, fqdn: 'host.example', secure: 1 } as never,
      baseUrl: 'https://coord.example/',
      apiKey: 'abc123',
    });
    const unavailable = renderTomlForHost({
      settings: {},
      host: { id: 7, fqdn: 'host.example', secure: 1 } as never,
      baseUrl: null,
      apiKey: null,
    });
    const claude = renderTomlForHost({
      settings: {},
      host: { id: 7, fqdn: 'host.example', secure: 1 } as never,
      baseUrl: 'https://coord.example/',
      apiKey: 'abc123',
      engine: ENGINE_CLAUDE,
    });

    for (const rendered of [mcpDisabled, unavailable, claude]) {
      expect(rendered.content).not.toContain('[[skills.config]]');
      expect(rendered.content).not.toContain('skill-creator');
    }
  });

  it('injects the managed skill policy idempotently', () => {
    const once = injectManagedCodexSkillPolicyToml('model = "gpt-5.6-terra"\n');
    const twice = injectManagedCodexSkillPolicyToml(once);

    expect(twice).toBe(once);
    expect(once.match(/\[\[skills\.config\]\]/g)).toHaveLength(1);
    expect(once).toContain('name = "skill-creator"');
    expect(once).toContain('enabled = false');
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

  it('injects the local Agent Messaging MCP whenever the fleet switch is on', () => {
    const host = {
      id: 7,
      fqdn: 'host.example',
      secure: 1,
    };
    const enabled = renderTomlForHost({
      settings: { orchestrator_mcp_enabled: false },
      host: host as never,
      baseUrl: null,
      apiKey: null,
      agentMessagingEnabled: true,
    });
    expect(enabled.content).toContain('[mcp_servers.cxx-agent]');
    expect(enabled.content).toContain('command = "cxx"');
    expect(enabled.content).toContain('args = ["agent", "mcp"]');
    // A local messaging server does not imply that fleet Skills are reachable.
    expect(enabled.content).not.toContain('[[skills.config]]');

    // Injection is provisioning, not authorization. An insecure host keeps the
    // agent_* tools; the server denies its calls per operation while the
    // allowed window is closed. Gating the tools on the window instead would
    // add and remove them every few minutes.
    const insecure = renderTomlForHost({
      settings: { orchestrator_mcp_enabled: false },
      host: { ...host, secure: 0 } as never,
      baseUrl: null,
      apiKey: null,
      agentMessagingEnabled: true,
    });
    expect(insecure.content).toContain('[mcp_servers.cxx-agent]');

    const fleetOff = renderTomlForHost({
      settings: { orchestrator_mcp_enabled: false },
      host: host as never,
      baseUrl: null,
      apiKey: null,
      agentMessagingEnabled: false,
    });
    expect(fleetOff.content).not.toContain('cxx-agent');
  });

  it('revalidates effort when a Codex host overrides the fleet model', () => {
    const switched = renderTomlForHost({
      settings: {
        model: 'gpt-5.6-terra',
        model_reasoning_effort: 'ultra',
        profile: 'workhorse',
        profiles: [
          { name: 'workhorse', model: 'gpt-5.6-terra', model_reasoning_effort: 'ultra' },
        ],
      },
      host: {
        modelOverride: 'gpt-5.5',
        reasoningEffortOverride: null,
      } as never,
      baseUrl: null,
      apiKey: null,
    });
    expect(switched.content).toContain('model = "gpt-5.5"');
    expect(switched.content).toContain('model_reasoning_effort = "medium"');
    expect(switched.content).not.toContain('model_reasoning_effort = "ultra"');
    expect(switched.content).toContain('[profiles.workhorse]');

    const inherited = renderTomlForHost({
      settings: {
        model: 'gpt-5.6-terra',
        model_reasoning_effort: 'ultra',
      },
      host: {
        modelOverride: null,
        reasoningEffortOverride: null,
      } as never,
      baseUrl: null,
      apiKey: null,
    });
    expect(inherited.content).toContain('model = "gpt-5.6-terra"');
    expect(inherited.content).toContain('model_reasoning_effort = "ultra"');

    const inheritedProfileModel = renderTomlForHost({
      settings: {
        model: 'gpt-5.5',
        model_reasoning_effort: 'high',
        profile: 'work',
        profiles: [{ name: 'work' }],
      },
      host: {
        modelOverride: null,
        reasoningEffortOverride: 'ultra',
      } as never,
      baseUrl: null,
      apiKey: null,
    });
    expect(inheritedProfileModel.content).toContain('model_reasoning_effort = "high"');
    expect(inheritedProfileModel.content).not.toContain('model_reasoning_effort = "ultra"');
  });
});

describe('client-config: renderClaudeSettingsPartial advisorModel', () => {
  it('renders advisorModel into the partial and owned_paths when set', () => {
    const { partial, owned_paths } = renderClaudeSettingsPartial(
      normalizeSettings({ advisorModel: 'opus' }, { applyCodexDefaults: false }),
    );
    expect(partial.advisorModel).toBe('opus');
    expect(owned_paths).toContain('advisorModel');
  });

  it('omits advisorModel from partial and owned_paths when off/invalid', () => {
    const { partial, owned_paths } = renderClaudeSettingsPartial(
      normalizeSettings({ advisorModel: 'gpt-5' }, { applyCodexDefaults: false }),
    );
    expect(partial).not.toHaveProperty('advisorModel');
    expect(owned_paths).not.toContain('advisorModel');
  });
});

/**
 * The Claude usage quota bar has no other data source: the server never
 * holds or calls out with a Claude OAuth token (Anthropic's Consumer ToS
 * prohibits third-party use of a Free/Pro/Max subscription's OAuth token),
 * so the fleet-owned statusLine command is the only channel that captures
 * Claude Code's own computed `rate_limits` reading and reports it up.
 */
describe('client-config: renderClaudeSettingsPartialForHost statusLine default', () => {
  const render = (
    claudeWrapperVersion: string | null,
    settings: Record<string, unknown> = {},
  ) =>
    renderClaudeSettingsPartialForHost({
      settings,
      host: { id: 1, secure: 1, claudeWrapperVersion } as never,
      baseUrl: 'https://orchestrator.example',
      apiKey: 'k'.repeat(40),
      engine: ENGINE_CLAUDE,
    } as never);

  it('installs the fleet quota-reporting statusLine once the host self-reports a new-enough wrapper', () => {
    const { partial, owned_paths } = render('0.7.24');
    expect(partial.statusLine).toEqual({ type: 'command', command: 'cxx claude-quota-statusline' });
    expect(owned_paths).toContain('statusLine');
  });

  it('a newer wrapper still gets the default', () => {
    const { partial } = render('0.8.0');
    expect(partial.statusLine).toEqual({ type: 'command', command: 'cxx claude-quota-statusline' });
  });

  // A host self-reports its OWN installed version, so this can only lag the
  // actual binary, never lead it -- withholding the default here is what
  // stops an older `cxx` (which does not understand the new statusLine
  // command yet) from being handed a statusLine it cannot run.
  it('withholds the default from a host on an older wrapper, to avoid handing it a command it cannot run', () => {
    // 0.7.23 is the latest tag as of writing and does not ship this command.
    const { partial, owned_paths } = render('0.7.23');
    expect(partial).not.toHaveProperty('statusLine');
    expect(owned_paths).not.toContain('statusLine');
  });

  it('withholds the default when the host has never reported a wrapper version', () => {
    const { partial } = render(null);
    expect(partial).not.toHaveProperty('statusLine');
  });

  it('lets an admin-configured statusLine win over the fleet default, even on a new-enough wrapper', () => {
    const custom = { type: 'command', command: 'my-custom-statusline' };
    const { partial, owned_paths } = render('0.7.24', { statusLine: custom });
    expect(partial.statusLine).toEqual(custom);
    expect(owned_paths).toContain('statusLine');
  });
});

/**
 * Claude Code exits immediately when the resolved mode is `bypassPermissions` and it is
 * running as root, with no supported override. Serving that combination does not produce
 * a permissive agent — it produces one that cannot launch, and the failure is silent:
 * a relay-booted peer dies before reporting and its delivery goes terminally `ambiguous`,
 * which is indistinguishable from a peer that declined to answer.
 */
describe('client-config: root permission-mode clamp', () => {
  const render = (permissionMode: string | undefined, username: string | null | undefined) =>
    renderClaudeSettingsPartialForHost({
      settings: permissionMode ? { permissionMode } : {},
      host: { id: 1, secure: 1 } as never,
      baseUrl: 'https://orchestrator.example',
      apiKey: 'k'.repeat(40),
      engine: ENGINE_CLAUDE,
      username,
    } as never);

  it('serves a root host auto instead of a mode it cannot boot with', () => {
    const { partial, clamped } = render('bypassPermissions', 'root');

    expect((partial.permissions as Record<string, unknown>).defaultMode).toBe('auto');
    expect(clamped).toEqual({ from: 'bypassPermissions', to: 'auto', username: 'root' });
  });

  it('leaves a non-root host on the bypass its posture asked for', () => {
    const { partial, clamped } = render('bypassPermissions', 'deploy');

    expect((partial.permissions as Record<string, unknown>).defaultMode).toBe('bypassPermissions');
    expect(clamped).toBeNull();
  });

  it('touches no other mode on a root host', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']) {
      const { partial, clamped } = render(mode, 'root');
      expect((partial.permissions as Record<string, unknown>).defaultMode).toBe(mode);
      expect(clamped).toBeNull();
    }
  });

  it('leaves a host it cannot identify alone rather than guessing', () => {
    // An older wrapper sends no username. Clamping on a guess would silently weaken a
    // host that may not be root at all; `clx doctor` names the problem host-side, where
    // the uid is known rather than asserted.
    for (const username of [null, undefined, '']) {
      const { partial, clamped } = render('bypassPermissions', username);
      expect((partial.permissions as Record<string, unknown>).defaultMode).toBe('bypassPermissions');
      expect(clamped).toBeNull();
    }
  });

  it('clamps delivery without touching what the posture asked for', () => {
    const asked = applyPostureToSettings({}, presetLevels('unrestricted'), ENGINE_CLAUDE);
    // The posture still reports the bypass; only what reaches the host changes. If this
    // ever needs the posture mapping edited too, the clamp landed in the wrong layer.
    expect(asked.permissionMode).toBe('bypassPermissions');

    const { settings, clamped } = clampClaudePermissionModeForUser(asked, 'root');
    expect(settings.permissionMode).toBe('auto');
    expect(asked.permissionMode).toBe('bypassPermissions');
    expect(clamped?.from).toBe('bypassPermissions');
  });
});

/**
 * The ringer's server half.
 *
 * An attached Claude session has no interrupt and the relay refuses to write to
 * it, so these two hooks are the only moments a queued peer message can be
 * announced at all. If they stop rendering, nothing fails loudly — calls just go
 * unanswered exactly as they did before, which is indistinguishable from a quiet
 * fleet.
 */
describe('client-config: the Agent Messaging ringer hooks', () => {
  const ringHooks = (agentMessagingEnabled: boolean) =>
    renderClaudeSettingsPartialForHost({
      settings: {},
      host: { id: 1, secure: 1 } as never,
      baseUrl: 'https://orchestrator.example',
      apiKey: 'k'.repeat(40),
      engine: ENGINE_CLAUDE,
      agentMessagingEnabled,
    } as never);

  it('ships a Stop and a UserPromptSubmit hook wherever the bus is provisioned', () => {
    const { partial, owned_paths } = ringHooks(true);
    const hooks = partial.hooks as Record<string, unknown[]>;

    expect(Object.keys(hooks).sort()).toEqual(['Stop', 'UserPromptSubmit']);
    for (const event of ['Stop', 'UserPromptSubmit']) {
      const command = String(
        ((hooks[event]![0] as Record<string, unknown[]>).hooks![0] as Record<string, unknown>).command,
      );
      expect(command).toContain(`cxx agent poll --hook ${event}`);
      // Not decoration: a Stop hook that exits non-zero BLOCKS the turn, so a
      // wrapper too old to know `agent poll` would wedge every turn on an
      // unknown-command error. Forcing exit 0 is what lets this ship without
      // version-gating.
      expect(command).toContain('|| true');
      // Ownership is what lets the wrapper remove them again if this ever drops.
      expect(owned_paths).toContain(`hooks.${event}`);
    }
  });

  it('renders no hooks at all when the bus is not provisioned', () => {
    const { partial, owned_paths } = ringHooks(false);
    expect(partial).not.toHaveProperty('hooks');
    expect(owned_paths).not.toContain('hooks.Stop');
    expect(owned_paths).not.toContain('hooks.UserPromptSubmit');
  });

  it('appends the ring to operator hooks rather than replacing them', () => {
    const operatorHook = { hooks: [{ type: 'command', command: 'operator-audit.sh' }] };
    const { partial } = renderClaudeSettingsPartialForHost({
      settings: { hooks: { Stop: [operatorHook], PreToolUse: [operatorHook] } },
      host: { id: 1, secure: 1 } as never,
      baseUrl: 'https://orchestrator.example',
      apiKey: 'k'.repeat(40),
      engine: ENGINE_CLAUDE,
      agentMessagingEnabled: true,
    } as never);
    const hooks = partial.hooks as Record<string, unknown[]>;

    // Same union as permissions.allow: claiming the path must not mean
    // discarding what the operator put there.
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop![0]).toEqual(operatorHook);
    expect(String(((hooks.Stop![1] as Record<string, unknown[]>).hooks![0] as Record<string, unknown>).command))
      .toContain('cxx agent poll');
    // An event the ring does not touch is left exactly as configured.
    expect(hooks.PreToolUse).toEqual([operatorHook]);
  });
});

describe('client-config: Claude effortLevel rendering', () => {
  it('renders effortLevel in both the full file and deep-merge ownership contract', () => {
    const settings = normalizeSettings({
      model: 'claude-opus-4-7',
      effortLevel: 'xhigh',
    }, { applyCodexDefaults: false });
    const { partial, owned_paths } = renderClaudeSettingsPartial(settings);
    expect(partial.effortLevel).toBe('xhigh');
    expect(owned_paths).toContain('effortLevel');

    const rendered = renderTomlForHost({
      settings,
      host: null,
      baseUrl: null,
      apiKey: null,
      engine: ENGINE_CLAUDE,
    });
    expect(JSON.parse(rendered.content)).toMatchObject({
      model: 'claude-opus-4-7',
      effortLevel: 'xhigh',
    });
  });

  it('uses the overridden Claude model default and omits unsupported host effort', () => {
    const opus = renderClaudeSettingsPartialForHost({
      settings: { model: 'claude-sonnet-4-6', effortLevel: 'high' },
      host: {
        claudeModelOverride: 'claude-opus-4-7',
        claudeReasoningEffortOverride: null,
      } as never,
      baseUrl: null,
      apiKey: null,
      engine: ENGINE_CLAUDE,
    });
    expect(opus.partial).toMatchObject({ model: 'claude-opus-4-7', effortLevel: 'xhigh' });
    expect(opus.owned_paths).toContain('effortLevel');

    const haiku = renderClaudeSettingsPartialForHost({
      settings: { model: 'claude-sonnet-4-6', effortLevel: 'high' },
      host: {
        claudeModelOverride: 'claude-haiku-4-5-20251001',
        claudeReasoningEffortOverride: 'high',
      } as never,
      baseUrl: null,
      apiKey: null,
      engine: ENGINE_CLAUDE,
    });
    expect(haiku.partial.model).toBe('claude-haiku-4-5-20251001');
    expect(haiku.partial).not.toHaveProperty('effortLevel');
    expect(haiku.owned_paths).not.toContain('effortLevel');
  });
});

describe('client-config: renderClaudeSettingsPartial permissions.defaultMode', () => {
  it('defaults to `auto` and renders it under permissions.defaultMode (never top-level)', () => {
    const { partial, owned_paths } = renderClaudeSettingsPartial(normalizeSettings({}, { applyCodexDefaults: false }));
    expect((partial.permissions as Record<string, unknown>).defaultMode).toBe('auto');
    expect(owned_paths).toContain('permissions.defaultMode');
    // The top-level key Claude Code ignores must NOT be emitted.
    expect(partial).not.toHaveProperty('permissionMode');
    expect(owned_paths).not.toContain('permissionMode');
  });

  it('honors an operator-pinned mode', () => {
    const { partial, owned_paths } = renderClaudeSettingsPartial(
      normalizeSettings({ permissionMode: 'default' }, { applyCodexDefaults: false }),
    );
    expect((partial.permissions as Record<string, unknown>).defaultMode).toBe('default');
    expect(owned_paths).toContain('permissions.defaultMode');
  });

  it('falls back to the default when the pinned mode is invalid', () => {
    const { partial } = renderClaudeSettingsPartial(
      normalizeSettings({ permissionMode: 'autoEdit' }, { applyCodexDefaults: false }),
    );
    expect((partial.permissions as Record<string, unknown>).defaultMode).toBe('auto');
  });

  it('keeps defaultMode alongside allow/ask/deny buckets and owns each leaf', () => {
    const { partial, owned_paths } = renderClaudeSettingsPartial(
      normalizeSettings({
        permissionMode: 'acceptEdits',
        permissions: { allow: ['Bash(npm run *)'], deny: ['Read(./secrets/**)'] },
      }, { applyCodexDefaults: false }),
    );
    const perms = partial.permissions as Record<string, unknown>;
    expect(perms.defaultMode).toBe('acceptEdits');
    // The wrapper's own CLI is always approved and unions with operator rules.
    expect(perms.allow).toEqual(['Bash(npm run *)', 'Bash(clx:*)', 'Bash(cxx:*)']);
    expect(perms.deny).toEqual(['Read(./secrets/**)']);
    expect(owned_paths).toEqual(
      expect.arrayContaining(['permissions.allow', 'permissions.deny', 'permissions.defaultMode']),
    );
  });
});

describe('client-config: memory curation permissions', () => {
  const withServer = (extra: Record<string, unknown> = {}) =>
    normalizeSettings(
      { mcp_servers: [{ name: 'clx', url: 'https://codex-auth.uggs.io/mcp' }], ...extra },
      { applyCodexDefaults: false },
    );

  // Reads were already frictionless while every write/append/delete prompted, so
  // the permission config pushed agents toward the read-only behaviour the corpus
  // shows (113 reads : 3 writes : 0 deletes). The AGENTS.md block now tells them
  // to correct stale records mid-task; the two must not disagree.
  it('allows the curation tools, namespaced to the configured server', () => {
    const { partial, owned_paths } = renderClaudeSettingsPartial(withServer());
    const allow = (partial.permissions as Record<string, unknown>).allow as string[];

    expect(allow).toEqual(expect.arrayContaining([
      'mcp__clx__shared_memory_write',
      'mcp__clx__shared_memory_append',
      'mcp__clx__shared_memory_delete',
      'mcp__clx__project_memory_upsert',
      'mcp__clx__project_memory_delete',
    ]));
    expect(owned_paths).toContain('permissions.allow');
  });

  // Read tools are deliberately NOT added here: they were never the friction.
  it('does not extend the allow-list to read tools', () => {
    const { partial } = renderClaudeSettingsPartial(withServer());
    const allow = (partial.permissions as Record<string, unknown>).allow as string[];
    expect(allow).not.toContain('mcp__clx__shared_memory_read');
    expect(allow).not.toContain('mcp__clx__shared_memory_list');
  });

  it('keeps operator-configured allow rules and does not duplicate', () => {
    const { partial } = renderClaudeSettingsPartial(
      withServer({ permissions: { allow: ['Bash(ls:*)', 'mcp__clx__shared_memory_write'] } }),
    );
    const allow = (partial.permissions as Record<string, unknown>).allow as string[];

    expect(allow).toContain('Bash(ls:*)');
    expect(allow.filter((r) => r === 'mcp__clx__shared_memory_write')).toHaveLength(1);
  });

  it('names no MCP tool when no server is configured, keeping only the wrapper CLI', () => {
    const { partial } = renderClaudeSettingsPartial(normalizeSettings({}, { applyCodexDefaults: false }));
    const allow = (partial.permissions as Record<string, unknown>).allow as string[];
    expect(allow).toEqual(['Bash(clx:*)', 'Bash(cxx:*)']);
  });
});

describe('client-config: Claude Agent Messaging permissions', () => {
  // The shape served to a Claude host follows that host's OWN wrapper version:
  // config syncs ahead of a self-update, so a host still on a pre-plugin
  // wrapper must keep the shape its binary actually produces.
  const claudeMessagingRender = (claudeWrapperVersion: string | null = '0.8.11') => renderClaudeSettingsPartialForHost({
    settings: { orchestrator_mcp_enabled: false },
    host: {
      id: 7,
      fqdn: 'host.example',
      secure: 1,
      agentMessagingEnabled: 1,
      claudeWrapperVersion,
    } as never,
    baseUrl: null,
    apiKey: null,
    engine: ENGINE_CLAUDE,
    agentMessagingEnabled: true,
  });

  // clx ships the server inside its per-launch `cxx-receiver` plugin, because a
  // plugin-provided server is the only kind Claude Code registers as a channel
  // without the development-channels confirmation. A user-scope entry of the
  // same name would duplicate every tool across two processes, only one of
  // which holds the delivery lease.
  it('leaves the messaging server to the wrapper plugin rather than user scope', () => {
    const { partial, owned_paths } = claudeMessagingRender();
    const servers = (partial.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    expect(servers['cxx-agent']).toBeUndefined();
    expect(owned_paths).not.toContain('mcpServers.cxx-agent');
  });

  it('allows the explicit agent tool surface under the plugin-scoped server name', () => {
    const { partial } = claudeMessagingRender();
    const allow = (partial.permissions as Record<string, unknown>).allow as string[];
    expect(allow).toEqual(expect.arrayContaining([
      'mcp__plugin_cxx-receiver_cxx-agent__agent_list',
      'mcp__plugin_cxx-receiver_cxx-agent__agent_send',
      'mcp__plugin_cxx-receiver_cxx-agent__agent_reply',
      'mcp__plugin_cxx-receiver_cxx-agent__agent_cancel',
    ]));
    expect(allow).not.toContain('mcp__plugin_cxx-receiver_cxx-agent__permission');
    // The pre-plugin identifiers must not linger: they would approve a server
    // Claude no longer has, and the wrapper removes rules that leave the set.
    expect(allow.some((rule) => rule.startsWith('mcp__cxx-agent__'))).toBe(false);
  });

  // Claude Code resolves a `server:<name>` channel against the enterprise,
  // managed, user, project and local MCP scopes only. A pre-plugin wrapper
  // passes the server on the command line, which is in none of them, so this
  // user-scope entry is the only thing keeping that host's channel alive --
  // and its tools are still `mcp__cxx-agent__*`.
  it('keeps the user-scope server and its tool names for a pre-plugin wrapper', () => {
    const { partial, owned_paths } = claudeMessagingRender('0.8.10');
    const servers = (partial.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    expect(servers['cxx-agent']).toBeDefined();
    expect(owned_paths).toContain('mcpServers.cxx-agent');
    const allow = (partial.permissions as Record<string, unknown>).allow as string[];
    expect(allow).toEqual(expect.arrayContaining([
      'mcp__cxx-agent__agent_list',
      'mcp__cxx-agent__agent_send',
    ]));
    expect(allow.some((rule) => rule.startsWith('mcp__plugin_cxx-receiver_cxx-agent__'))).toBe(false);
  });

  // A host that has never reported a wrapper version cannot be assumed to have
  // upgraded, so it is treated as pre-plugin.
  it('treats an unknown wrapper version as pre-plugin', () => {
    const { partial } = claudeMessagingRender(null);
    const servers = (partial.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    expect(servers['cxx-agent']).toBeDefined();
  });

  it('still names the plain server on Codex, which has no plugin surface', () => {
    const { content } = renderTomlForHost({
      settings: { orchestrator_mcp_enabled: false },
      host: { id: 7, fqdn: 'host.example', secure: 1, agentMessagingEnabled: 1 } as never,
      baseUrl: null,
      apiKey: null,
      agentMessagingEnabled: true,
    });
    expect(content).toContain('[mcp_servers.cxx-agent]');
  });
});

/**
 * Posture is applied as a bake-time overlay, never written back into the stored
 * document. `docs/CONFIG_BUILDER.md` warns against a second editable owner of
 * config.toml, and with several profiles over one fleet document there is no
 * answer to "whose values get stored".
 */
describe('client-config: security posture overlay', () => {
  const base = {
    model: 'gpt-5.6-terra',
    approval_policy: 'on-request',
    sandbox_mode: 'workspace-write',
    sandbox_workspace_write: { writable_roots: ['/srv/app'] },
  };

  it('leaves the template untouched when no posture is resolved', () => {
    const toml = renderTomlForHost({ settings: base, host: null, baseUrl: null, apiKey: null }).content;
    expect(toml).toContain('approval_policy = "on-request"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
  });

  it('overrides the template’s values for the keys posture claims', () => {
    const toml = renderTomlForHost({
      settings: base,
      host: null,
      baseUrl: null,
      apiKey: null,
      securityLevels: presetLevels('unrestricted'),
    }).content;
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('sandbox_mode = "danger-full-access"');
    expect(toml).toContain('network_access = true');
  });

  it('clamps to the template’s strictest neighbour at Contained', () => {
    const toml = renderTomlForHost({
      settings: base,
      host: null,
      baseUrl: null,
      apiKey: null,
      securityLevels: presetLevels('contained'),
    }).content;
    expect(toml).toContain('approval_policy = "untrusted"');
    expect(toml).toContain('sandbox_mode = "read-only"');
    expect(toml).toContain('network_access = false');
  });

  it('keeps the operator’s writable_roots while claiming only network_access', () => {
    const toml = renderTomlForHost({
      settings: base,
      host: null,
      baseUrl: null,
      apiKey: null,
      securityLevels: presetLevels('unrestricted'),
    }).content;
    expect(toml).toContain('writable_roots = ["/srv/app"]');
  });

  it('never emits the dead bypass key, even fully unrestricted', () => {
    // The server renders [security] but no Go code parses it, and the wrapper
    // reads a signed engine_options key the baker never emits. Deriving it
    // would be a level that claims to unlock something and does nothing.
    const toml = renderTomlForHost({
      settings: base,
      host: null,
      baseUrl: null,
      apiKey: null,
      securityLevels: presetLevels('unrestricted'),
    }).content;
    expect(toml).not.toContain('dangerously_bypass_approvals_and_sandbox');
  });

  it('drives the Claude partial’s permission mode from posture', () => {
    const contained = renderClaudeSettingsPartialForHost({
      settings: {}, host: null, baseUrl: null, apiKey: null, engine: ENGINE_CLAUDE,
      securityLevels: presetLevels('contained'),
    });
    const open = renderClaudeSettingsPartialForHost({
      settings: {}, host: null, baseUrl: null, apiKey: null, engine: ENGINE_CLAUDE,
      securityLevels: presetLevels('unrestricted'),
    });
    const mode = (p: { partial: Record<string, unknown> }): unknown =>
      (p.partial['permissions'] as Record<string, unknown> | undefined)?.['defaultMode'];
    expect(mode(contained)).toBe('plan');
    expect(mode(open)).toBe('bypassPermissions');
  });

  it('lands Standard on the mode the fleet already runs', () => {
    // Standard must not move a single Claude host on the day this deploys.
    const std = renderClaudeSettingsPartialForHost({
      settings: {}, host: null, baseUrl: null, apiKey: null, engine: ENGINE_CLAUDE,
      securityLevels: presetLevels('standard'),
    });
    expect((std.partial['permissions'] as Record<string, unknown>)['defaultMode']).toBe(
      DEFAULT_CLAUDE_PERMISSION_MODE,
    );
  });
});
