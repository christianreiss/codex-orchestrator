import { describe, it, expect } from 'vitest';
import inventory from '../../../src/services/chatty/surface-inventory.json' with { type: 'json' };
import { ROUTE_CAPABILITIES } from '../../../src/security/route-capabilities.js';
import { administrationTools } from '../../../src/services/chatty/tools.js';

describe('Chatty admin surface coverage', () => {
  it('classifies every admin route exactly once and rejects stale entries', () => {
    const routes = [
      ...Object.keys(inventory.tool),
      ...inventory.interactive_handoff.routes,
      ...inventory.excluded.routes,
    ];
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.sort()).toEqual(
      Object.keys(ROUTE_CAPABILITIES)
        .filter((k) => k.includes(' /admin/'))
        .sort(),
    );
  });
  it('links callable entries to a real typed domain tool', () => {
    const names = new Set(administrationTools().map((t) => t.name));
    for (const name of Object.values(inventory.tool)) expect(names.has(name), name).toBe(true);
    expect(inventory.excluded.routes).toContain('POST /admin/schedules');
    expect(inventory.excluded.routes).toContain('POST /admin/daemon-sessions');
  });
});
