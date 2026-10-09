<script lang="ts">
 import { onMount } from 'svelte';
 import type { DaemonHost } from '$lib/api/hostDaemons';
 import { wsStatus } from '$lib/stores/ws-status';
 let { host }: {host:DaemonHost|undefined}=$props();
 let now=$state(Date.now());
 onMount(()=>{const timer=setInterval(()=>now=Date.now(),5000);return()=>clearInterval(timer)});
 const stale=$derived($wsStatus!=='open'||!!host&&now-Date.parse(host.health.evaluated_at)>45_000);
 const color=$derived(stale&&host?.health.state==='green'?'yellow':host?.health.state);
 const reasons:Record<string,string>={installation_pending:'Installation ausstehend',heartbeat_expired:'Daemon nicht erreichbar',reconnecting:'Verbindung wird wiederhergestellt',service_user_mismatch:'Dienstkonto stimmt nicht überein',no_engine_ready:'Keine Engine bereit',engines_partially_ready:'Nicht alle Engines bereit',busy:'Alle Arbeitsplätze belegt',host_access_blocked:'Host-Zugriff gesperrt'};
 const label=$derived(color==='green'?'Bereit':color==='red'?'Nicht verfügbar':'Eingeschränkt');
 const details=$derived(host?`Daemon: ${label} · ${host.health.used_slots}/${host.health.max_slots} Slots · ${stale?'Live-Status unbekannt':host.health.reasons.map(r=>reasons[r]??r).join(', ')} · Letzter Kontakt: ${host.health.heartbeat_at?new Date(host.health.heartbeat_at).toLocaleString():'noch keiner'}`:'');
</script>
{#if host?.enabled}
 <span class="inline-flex items-center gap-1.5 text-xs" role="img" aria-label={details} title={details} data-daemon-state={color}>
  <span aria-hidden="true" class={`h-2.5 w-2.5 rounded-full ${color==='green'?'bg-green-500':color==='red'?'bg-red-500':'bg-yellow-500'}`}></span>
  <span>Daemon · {label}</span>
 </span>
{/if}
