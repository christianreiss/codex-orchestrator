import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
import { authStore } from '$lib/stores/auth';
import { derived } from 'svelte/store';
import { apiFetch } from './client';
export interface SupervisorWork {
 target: string; taskKey: string; state: string; reason: string | null;
 waitingForAddressId: string | null; waitingForMessageId: string | null;
 lastProgressAt: string; reminderAt: string | null; deadlineAt: string | null;
 paused: number; escalation: string | null; version: number; attempts: number; nextAttemptAt: string | null;
 watchdogId: string | null;
}
export interface SupervisorDependency {id:string;waiterAddressId:string;dependencyAddressId:string;messageId:string|null;workflowTaskId:string|null;status:string;reminderAt:string|null}
export interface SupervisorView { dependencies:SupervisorDependency[]; enabled: boolean; effective: boolean; states: SupervisorWork[] }
export const supervisorKey = ['supervisor'] as const;
export function supervisorQuery() {
 return createQuery(derived(authStore, auth => ({ queryKey: supervisorKey, enabled: auth.can('agent_messaging.read'), queryFn: () => apiFetch<SupervisorView>('/admin/agent-supervisor') })));
}
export function writeSupervisor(enabled: boolean) { return apiFetch<SupervisorView>('/admin/agent-supervisor/state', {method:'POST',body:{enabled}}); }
export function supervisorPause() {
 const client = useQueryClient();
 return createMutation({ mutationFn: (work:SupervisorWork) => apiFetch('/admin/agent-supervisor/pause',{method:'POST',body:{target:work.target,version:work.version}}), retry:false,
 onSuccess: () => client.invalidateQueries({queryKey:supervisorKey}) });
}
