<script lang="ts">
 import { authStore } from '$lib/stores/auth';
 import { useQueryClient } from '@tanstack/svelte-query';
 import { hostDaemonQuery, configureDaemon, daemonDefaults } from '$lib/api/hostDaemons';
 import DaemonIndicator from './DaemonIndicator.svelte';
 import RemoteSessions from '$lib/components/portal/RemoteSessions.svelte';
 let {id}:{id:string|number}=$props();
 // svelte-ignore state_referenced_locally
 const query=hostDaemonQuery(id),save=configureDaemon(useQueryClient(),id);
 let settings=$state({...daemonDefaults}),dirty=$state(false);
 $effect(()=>{if($query.data&&!dirty){const {enabled,username,default_cwd,max_parallel,idle_minutes,question_minutes}=$query.data;settings={enabled,username,default_cwd,max_parallel,idle_minutes,question_minutes}}});
</script>
<section class="space-y-4 rounded-xl border border-border bg-card p-5">
 <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-semibold">Remote-Sessions</h2><DaemonIndicator host={$query.data}/></div>
 <p class="text-sm text-muted-foreground">Optionaler Linux-Dienst für neue Sessions auf diesem Host. Agent Messaging muss für diesen Host und die Flotte aktiviert sein. Nach Freigabe übernimmt der nächste Wrapper-Sync die Installation mit ausreichenden Rechten.</p>
 {#if $query.error}<p role="alert">{$query.error.message}</p>{/if}
 <fieldset disabled={!$authStore.can("agent_messaging.manage")}><form class="grid gap-3 sm:grid-cols-2" oninput={()=>dirty=true} onsubmit={async(e)=>{e.preventDefault();await $save.mutateAsync(settings);dirty=false}}>
  <label class="flex items-center gap-2 sm:col-span-2"><input type="checkbox" bind:checked={settings.enabled}/> Remote-Starts aktivieren</label>
  <label class="grid gap-1 text-sm">Dienstkonto<input class="rounded border bg-background p-2" bind:value={settings.username} required/></label>
  <label class="grid gap-1 text-sm">Standardverzeichnis<input class="rounded border bg-background p-2" bind:value={settings.default_cwd} placeholder="/home/chris/Documents"/></label>
  <label class="grid gap-1 text-sm">Parallele Arbeitsslots<input class="rounded border bg-background p-2" type="number" min="1" max="64" bind:value={settings.max_parallel}/></label>
  <label class="grid gap-1 text-sm">Idle-Frist (Minuten)<input class="rounded border bg-background p-2" type="number" min="1" max="1440" bind:value={settings.idle_minutes}/></label>
  <label class="grid gap-1 text-sm">Rückfragefrist (Minuten)<input class="rounded border bg-background p-2" type="number" min="1" max="10080" bind:value={settings.question_minutes}/></label>
  <button class="self-end rounded bg-primary px-4 py-2 text-primary-foreground" disabled={$save.isPending||$query.isPending}>Speichern</button>
  {#if $save.error}<p role="alert" class="text-destructive sm:col-span-2">{$save.error.message}</p>{/if}
 </form></fieldset>
 {#if $query.data?.enabled}<RemoteSessions fixedHost={Number(id)}/>{/if}
</section>
