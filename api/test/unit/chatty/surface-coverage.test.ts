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
  it('exposes administration reads and confirmed configuration changes across every added feature', () => {
    const tools = administrationTools();
    for (const name of [
      'supervisor_state_set',
      'supervisor_pause',
      'workflow_create',
      'workflow_revise',
      'role_create',
      'role_publish',
      'server_retention_policy_set',
      'server_retention_run',
      'quota_policy_update',
      'account_quota_policy_update',
      'quota_mode_update',
      'quota_scaling_update',
    ]) {
      expect(
        tools.find((tool) => tool.name === name),
        name,
      ).toMatchObject({ write: true, confirm: true });
    }
    for (const name of [
      'workflow_run_read',
      'workflow_run_events',
      'workflow_run_report',
      'supervisor_read',
      'watchdog_read',
    ])
      expect(
        tools.find((tool) => tool.name === name),
        name,
      ).toMatchObject({ write: false });
    for (const route of [
      'POST /admin/workflow-runs',
      'POST /admin/workflow-runs/:id/control',
      'POST /admin/watchdogs',
      'POST /admin/schedules',
      'POST /admin/daemon-sessions',
    ])
      expect(inventory.excluded.routes).toContain(route);
  });
});
