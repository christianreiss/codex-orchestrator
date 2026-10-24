import { createQuery } from '@tanstack/svelte-query';
import { api } from './client';
import { derived } from 'svelte/store';
import { authStore } from '$lib/stores/auth';
export interface CoordinationState { enabled: boolean; protocol: number; shell_enforcement: boolean }
export const coordinationStateKey = ['agent-coordination-state'] as const;
function checkedState(value: CoordinationState): CoordinationState {
  if (typeof value?.enabled !== 'boolean') throw new Error('The server did not confirm the coordination setting.');
  return value;
}
export async function readCoordinationState(): Promise<CoordinationState> {
  return checkedState(await api.get<CoordinationState>(`${scopeBase}/state`));
}
export async function writeCoordinationState(enabled: boolean): Promise<CoordinationState> {
  return checkedState(await api.post<CoordinationState>(`${scopeBase}/state`, { enabled }));
}
export function coordinationStateQuery() {
  return createQuery(derived(authStore, auth => ({ queryKey: coordinationStateKey, queryFn: readCoordinationState, enabled: auth.can('agent_messaging.read'), retry: false })));
}
export interface ScopeMember { session_id: string; agent_id: string | null; name: string | null; engine: string; host_id: number; host: string; cwd: string; coordinated: boolean; workspace: { git_root: string | null; git_common_dir: string | null; branch?: string | null; head_sha?: string | null } | null }
export interface ScopeRoom { id: string; key: string; kind: 'project' | 'host'; title: string; cursor: number; member_count: number; members: ScopeMember[]; next_member_offset: number | null }
export interface ResourceClaim { scope_ids?: string[]; id: string; session_id: string; state: string; purpose: string; resources: unknown; blockers: unknown; isolation_available: boolean; expires_at: string }
export interface ScopeSnapshot { enabled: boolean; observed_at?: string; rooms: ScopeRoom[]; claims: ResourceClaim[] }
export interface RoomEvent { id: string; sequence: number; kind: string; actor: string; body: { name?: string; content?: string; action?: string; purpose?: string; reason?: string }; created_at: string }
export interface RoomHistory { events: RoomEvent[]; next_before: number | null; cursor: number; members: ScopeMember[]; member_count: number }
export const scopeBase = '/admin/agent-messaging/scopes';
export function coordinationQuery() {
  return createQuery({ queryKey: ['agent-scopes'], queryFn: async (): Promise<ScopeSnapshot> => {
    const snapshot = await api.get<ScopeSnapshot>(scopeBase);
    for (const room of snapshot.rooms) {
      let offset = room.next_member_offset;
      while (offset !== null) {
        const page = await api.get<{ members: ScopeMember[]; next_member_offset: number | null }>(`${scopeBase}/${room.id}/members?offset=${offset}`);
        room.members.push(...page.members); offset = page.next_member_offset;
      }
    }
    return snapshot;
  } });
}
