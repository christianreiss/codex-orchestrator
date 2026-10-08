import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
import { derived, type Readable } from 'svelte/store';
import { apiFetch } from './client';
export interface Watchdog {
 id:string; target:string; task_key:string; status:string; version:number;
 deadline_at:string; last_progress_at:string; last_wake_at:string|null; next_wake_at:string|null;
 recovery_count:number; recovery_status:string|null; last_error:string|null; server_time:string;
}
export function watchdogsQuery(target:Readable<string>) {
 return createQuery(derived(target,v=>({queryKey:['watchdogs',v],enabled:!!v,queryFn:()=>apiFetch<{watchdogs:Watchdog[]}>('/admin/watchdogs?target='+encodeURIComponent(v)),refetchInterval:15000})));
}
export function watchdogMutation() {
 const client=useQueryClient();
 return createMutation<unknown,Error,{id?:string;body:unknown}>({mutationFn:({id,body})=>apiFetch('/admin/watchdogs'+(id?'/'+id+'/disable':''),{method:'POST',body}),onSuccess:()=>client.invalidateQueries({queryKey:['watchdogs']})});
}
