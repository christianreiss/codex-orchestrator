import { describe, expect, it } from 'vitest';
import { launchCapabilities } from '../../../src/control-plane/state/session-update.js';

describe('launch capabilities across receive-plane binds', () => {
  it('keeps the process facts a listen or receiver bind does not repeat', () => {
    const launch = { suspend_recovery_version: 1, launch_identity_version: 1, supervisor_model: 'opus', listen: false };
    const bind = { listen: true, scope_protocol_version: 1 };
    expect({ ...bind, ...launchCapabilities(launch) }).toEqual({
      listen: true,
      scope_protocol_version: 1,
      suspend_recovery_version: 1,
      launch_identity_version: 1,
      supervisor_model: 'opus',
    });
    expect(launchCapabilities(null)).toEqual({});
  });
});
