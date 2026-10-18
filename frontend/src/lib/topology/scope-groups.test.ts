import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ScopeRoom, ResourceClaim } from '../api/coordination';
const modulePath: string = './scope-groups.ts';
const { scopeGroups } = (await import(modulePath)) as typeof import('./scope-groups');
it('keeps empty rooms with uncertain ownership reachable for operator resolution', () => {
  const room: ScopeRoom = { id: 'project', key: 'repo:test', kind: 'project', title: 'Project', cursor: 2, member_count: 0, members: [], next_member_offset: null };
  const claim: ResourceClaim = { id: 'claim', session_id: 'ended', scope_ids: ['project'], state: 'uncertain', purpose: 'unfinished operation', resources: [], blockers: [], isolation_available: false, expires_at: '' };
  const groups = scopeGroups([], [room], [claim], 'project');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].room?.id, room.id);
  assert.equal(groups[0].conflicts, 1);
  assert.equal(groups[0].agents.length, 0);
  assert.equal(scopeGroups([], [room], [], 'project').length, 0);
});
