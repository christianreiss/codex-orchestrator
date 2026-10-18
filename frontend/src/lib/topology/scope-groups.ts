import type { ScopeRoom, ResourceClaim } from '$lib/api/coordination';
import type { TopologyAgent } from '$lib/api/topology';
export function scopeGroups(agents: TopologyAgent[], rooms: ScopeRoom[], claims: ResourceClaim[], grouping: 'project' | 'host') {
  const grouped = new Map<string, { id: string; title: string; room: ScopeRoom | null; agents: TopologyAgent[]; conflicts: number }>();
  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    const room = rooms.find(r => r.kind === grouping && r.members.some(m => m.session_id === agent.id));
    const id = room?.id ?? (grouping === 'host' ? `host:${agent.host_id}` : 'unassigned');
    const group = grouped.get(id) ?? { id, title: room?.title ?? (grouping === 'host' ? agent.host : 'Unassigned'), room: room ?? null, agents: [], conflicts: 0 };
    group.agents.push(agent);
    group.conflicts += claims.filter(c => c.session_id === agent.id && ['waiting', 'uncertain'].includes(c.state)).length;
    grouped.set(id, group);
  }
  for (const room of rooms.filter(r => r.kind === grouping)) {
    const unresolved = claims.filter(c => c.scope_ids?.includes(room.id) && c.state === 'uncertain');
    if (!unresolved.length) continue;
    const group = grouped.get(room.id) ?? { id: room.id, title: room.title, room, agents: [], conflicts: 0 };
    group.conflicts += unresolved.filter(c => !group.agents.some(a => a.id === c.session_id)).length;
    grouped.set(room.id, group);
  }
  return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
}
