import { describe, expect, it } from 'vitest';
import type { AgentBusAddress } from '../../../../src/db/schema.js';
import { publicAddress } from '../../../../src/services/agent-messaging/views.js';

describe('peer model metadata', () => {
  it.each(['codex', 'claude', 'grok', 'kimi'])('labels %s recovery configuration without claiming a live model', (engine) => {
    const capabilities = { supervisor_model: 'configured-model', supervisor_protocol_version: 1 };
    const address = { engine, adapterCapabilities: capabilities } as unknown as AgentBusAddress;
    expect(publicAddress(address).adapter_capabilities).toEqual({
      ...capabilities, supervisor_model_scope: 'launch_configuration',
    });
    expect(capabilities).not.toHaveProperty('supervisor_model_scope');
  });

  it('does not invent a model for an older adapter without one', () => {
    expect(publicAddress({ adapterCapabilities: null } as AgentBusAddress).adapter_capabilities).toBeNull();
  });
});
