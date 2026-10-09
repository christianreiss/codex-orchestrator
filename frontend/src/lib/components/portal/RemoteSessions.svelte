<script lang="ts">
 import { toStore } from "svelte/store";
 import { createQuery,createMutation,useQueryClient } from '@tanstack/svelte-query';
 import { api } from '$lib/api/client';
 import type { DaemonHost,RemoteSession } from '$lib/api/hostDaemons';
 let {fixedHost,portal=false}:{fixedHost?:number;portal?:boolean}=$props();
 const qc=useQueryClient();
 const root=$derived(portal?'/go/api':'/admin');
 const hosts=createQuery(toStore(()=>({queryKey:['host-daemons',portal?'portal':'list'],queryFn:()=>api.get<{hosts:DaemonHost[]}>(`${root}/host-daemons`),refetchInterval:15_000})));
 let hostId=$state(0),engine=$state('codex'),cwd=$state(''),title=$state(''),prompt=$state(''),selected=$state(''),message=$state('');
 let startKey=$state(crypto.randomUUID()),turnKey=$state(crypto.randomUUID());
 const available=$derived(($hosts.data?.hosts??[]).filter(h=>h.enabled&&(!fixedHost||h.host_id===fixedHost)));
 const host=$derived(available.find(h=>h.host_id===hostId));
 $effect(()=>{if(fixedHost)hostId=fixedHost;else if(!hostId&&available[0])hostId=available[0].host_id});
 const detail=createQuery<RemoteSession>(toStore(()=>({queryKey:['daemon-sessions',selected],queryFn:()=>api.get<RemoteSession>(`${root}/daemon-sessions/${selected}`),enabled:!!selected,refetchInterval:3000})));
 const refresh=()=>{void qc.invalidateQueries({queryKey:['host-daemons']});void qc.invalidateQueries({queryKey:['daemon-sessions']})};
 const start=createMutation({mutationFn:()=>api.post<{session_id:string}>(`${root}/daemon-sessions`,{host_id:hostId,engine,cwd:cwd||host?.default_cwd,title,prompt,client_message_id:startKey}),onSuccess:r=>{selected=r.session_id;startKey=crypto.randomUUID();prompt='';refresh()}});
 const turn=createMutation({mutationFn:()=>api.post(`${root}/daemon-sessions/${selected}/messages`,{prompt:message,client_message_id:turnKey}),onSuccess:()=>{message='';turnKey=crypto.randomUUID();refresh()}});
 const stop=createMutation({mutationFn:()=>api.post(`${root}/daemon-sessions/${selected}/stop`,{}),onSuccess:refresh});
</script>
<div class="space-y-4">
 <details class="rounded-lg border border-border p-3">
  <summary class="cursor-pointer font-semibold">Neue Remote-Session</summary>
  <form class="mt-3 grid gap-3 sm:grid-cols-2" oninput={()=>startKey=crypto.randomUUID()} onsubmit={e=>{e.preventDefault();$start.mutate()}}>
   <label class="grid gap-1 text-sm">Host<select class="rounded border bg-background p-2" bind:value={hostId} disabled={!!fixedHost}>{#each available as h}<option value={h.host_id}>{h.fqdn??`Host #${h.host_id}`}</option>{/each}</select></label>
   <label class="grid gap-1 text-sm">Engine<select class="rounded border bg-background p-2" bind:value={engine}><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select></label>
   <label class="grid gap-1 text-sm">Titel<input class="rounded border bg-background p-2" bind:value={title} maxlength="160" required/></label>
   <label class="grid gap-1 text-sm">Arbeitsverzeichnis<input class="rounded border bg-background p-2" bind:value={cwd} placeholder={host?.default_cwd||'/absoluter/pfad'}/></label>
   <label class="grid gap-1 text-sm sm:col-span-2">Auftrag<textarea class="rounded border bg-background p-2" bind:value={prompt} required rows="3"></textarea></label>
   <button class="rounded bg-primary px-4 py-2 text-primary-foreground" disabled={!host||host.health.state==='red'||$start.isPending}>Session starten</button>
  </form>
 </details>
 {#if $hosts.error||$start.error||$turn.error||$stop.error}<p role="alert" class="text-destructive">{($hosts.error??$start.error??$turn.error??$stop.error)?.message}</p>{/if}
 {#each available as h}
  {#each h.sessions as session}
   <button class="mr-2 mb-2 rounded border px-3 py-2 text-sm" class:bg-muted={selected===session.id} onclick={()=>selected=session.id}>{session.title} · {session.engine} · {session.status}</button>
  {/each}
 {/each}
 {#if $detail.data}
  <section class="space-y-3 rounded border p-3" aria-label="Remote-Session">
   <h3 class="font-semibold">{$detail.data.title} · {$detail.data.status}</h3>
   {#each $detail.data.operations??[] as op}<div class="whitespace-pre-wrap text-sm">{op.result?.reply||op.status}</div>{/each}
   {#if $detail.data.sessionId}<a class="text-sm underline" href={`/go#/a/${$detail.data.sessionId}`}>Nativen Session-Verlauf öffnen</a>{/if}
   <form oninput={()=>turnKey=crypto.randomUUID()} class="space-y-2" onsubmit={e=>{e.preventDefault();$turn.mutate()}}>
    <label class="grid gap-1 text-sm">Nachricht / Fortsetzen<textarea class="rounded border bg-background p-2" bind:value={message} required></textarea></label>
    <button class="rounded bg-primary px-3 py-2 text-primary-foreground" disabled={$turn.isPending||['running','queued','stopping'].includes($detail.data.status)}>Senden / Fortsetzen</button>
    <button type="button" class="ml-2 rounded border px-3 py-2" onclick={()=>$stop.mutate()} disabled={$stop.isPending||$detail.data.status==='closed'}>Beenden</button>
   </form>
  </section>
 {/if}
</div>
