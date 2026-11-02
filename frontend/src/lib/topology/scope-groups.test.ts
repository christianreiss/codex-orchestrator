import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ScopeRoom, ResourceClaim } from '../api/coordination';
import type { TopologyAgent } from '../api/topology';
const modulePath: string = './scope-groups.ts';
const { scopeGroups, projectDirectoryClouds } = (await import(modulePath)) as typeof import('./scope-groups');
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
it('clouds require the same project and exact local directory, never just a host', () => {
  const agent = (id: string, cwd: string, host_id = 32) => ({ id, cwd, host_id } as TopologyAgent);
  const room = (id: string, kind: 'project' | 'host') => ({ id, kind, title: id } as ScopeRoom);
  const grouped = (id: string, kind: 'project' | 'host', agents: TopologyAgent[]) => ({ id, title: id, room: room(id, kind), agents, conflicts: 0 });
  const a = agent('a', '/repo'), b = agent('b', '/repo'), worktree = agent('worktree', '/repo-wt'), remote = agent('remote', '/repo', 33);
  const groups = [grouped('project', 'project', [a, b, worktree, remote]),
    grouped('other-project', 'project', [agent('other', '/repo')]),
    grouped('host-only', 'host', [a, b, worktree]),
    grouped('unknown-dir', 'project', [agent('missing-a', ''), agent('missing-b', '')])];
  const before = JSON.stringify(groups);
  const clouds = projectDirectoryClouds(groups);
  assert.equal(clouds.length, 1);
  assert.equal(clouds[0].scopeId, 'project');
  assert.deepEqual(clouds[0].members, ['a', 'b']);
  assert.equal(JSON.stringify(groups), before);
  assert.deepEqual(clouds, projectDirectoryClouds([...groups].reverse().map(g => ({ ...g, agents: [...g.agents].reverse() }))));
});
