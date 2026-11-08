import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RtkPolicy } from './rtk';
const modulePath: string = './rtk.ts';
const { rtkReadiness } = await import(modulePath) as typeof import('./rtk');
const policy: RtkPolicy = { enabled: true, fleet: true, source: 'fleet', override: null, policy_revision: 'new', assigned: true };
test('RTK never infers availability from enabled policy', () => {
  assert.equal(rtkReadiness(policy), 'Not reported');
  assert.equal(rtkReadiness({ ...policy, assigned: false }), 'Engine not assigned');
});
test('RTK distinguishes reported readiness from policy application', () => {
  const observation = { engine: 'codex' as const, ready: true, wrapper_version: 'x', native_version: 'y', rtk_version: '1.2.0', policy_revision: 'old', observed_at: '2026-11-08T00:00:00Z' };
  assert.match(rtkReadiness({ ...policy, observation }, Date.parse(observation.observed_at)), /Previous policy/);
  assert.equal(rtkReadiness({ ...policy, observation: { ...observation, policy_revision: 'new' } }, Date.parse(observation.observed_at)), 'Adapter prepared at last report');
  assert.equal(rtkReadiness({ ...policy, observation: { ...observation, policy_revision: 'new', ready: false } }, Date.parse(observation.observed_at)), 'Adapter unavailable at last report');
});

test("RTK old reports do not imply current readiness", () => {
 const observation = {engine:"codex" as const,ready:true,wrapper_version:"x",native_version:"x",rtk_version:"1.2.0",policy_revision:"new",observed_at:"2026-11-08T00:00:00Z"};
 assert.match(rtkReadiness({...policy,observation}, Date.parse("2026-11-10T00:00:00Z")), /older than 24 hours/);
});
