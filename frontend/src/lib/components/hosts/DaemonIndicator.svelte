<script lang="ts">
  import { formatDateTime } from "$lib/utils/format";
 import { onMount } from 'svelte';
 import type { DaemonHost } from '$lib/api/hostDaemons';
 import { wsStatus } from '$lib/stores/ws-status';
 let { host }: {host:DaemonHost|undefined}=$props();
 let now=$state(Date.now());
 onMount(()=>{const timer=setInterval(()=>now=Date.now(),5000);return()=>clearInterval(timer)});
 const stale=$derived($wsStatus!=='open'||!!host&&host.health.presence_source!=='connection'&&now-Date.parse(host.health.evaluated_at)>45_000);
 const color=$derived(stale&&host?.health.state==='green'?'yellow':host?.health.state);
 const reasons:Record<string,string>={migration_pending:'Migration pending',installation_pending:'Installation pending',heartbeat_expired:'Daemon unreachable',reconnecting:'Reconnecting',service_user_mismatch:'Service user does not match',no_engine_ready:'No engine ready',engines_partially_ready:'Not every engine is ready',busy:'All slots in use',host_access_blocked:'Host access blocked',insecure_window_closed:'Access window closed'};
 const label=$derived(host?.access?.reason==='insecure_window_closed'&&!stale&&color!=='red'&&(host.health.presence_source==='connection'||!!host.health.heartbeat_at&&now-Date.parse(host.health.heartbeat_at)<45_000)&&!host.health.reasons.includes('reconnecting')?'Online · access blocked':color==='green'?'Ready':color==='red'?'Unavailable':'Limited');
 const details=$derived(host?`Daemon: ${label} · ${host.health.used_slots}/${host.health.max_slots} slots · ${stale?'live status unknown':host.health.reasons.map(r=>reasons[r]??r).join(', ')} · Last contact: ${host.health.heartbeat_at?formatDateTime(host.health.heartbeat_at):'none yet'}`:'');
</script>
{#if host?.enabled}
 <span class="inline-flex items-center gap-1.5 text-body-sm" role="img" aria-label={details} title={details} data-daemon-state={color}>
  <span aria-hidden="true" class={`h-2.5 w-2.5 rounded-full ${color==='green'?'bg-success':color==='red'?'bg-destructive':'bg-warning'}`}></span>
  <span>Daemon · {label}</span>
 </span>
{/if}
