<script lang="ts">
 import { createMutation, useQueryClient } from '@tanstack/svelte-query';
 import { supervisorQuery, supervisorKey, writeSupervisor } from '$lib/api/supervisor';
 import { authStore } from '$lib/stores/auth';
 import { Section, StateBlock, SaveState } from '$lib/components/page';
 import { Switch } from '$lib/components/ui/switch';
 import { Button } from '$lib/components/ui/button';
 import SupervisorStatus from '$lib/components/topology/SupervisorStatus.svelte';
 const query = supervisorQuery();
 const client = useQueryClient();
 const mutation = createMutation({mutationFn:writeSupervisor,retry:false});
 const canManage = $derived($authStore.can('agent_messaging.manage'));
 let attempted = $state<boolean|null>(null);
 let error = $state<unknown>(null);
 let saved = $state(false);
 async function check() {
   try { const result = await $query.refetch({throwOnError:true});
     if (attempted !== null && result.data?.enabled === attempted) {attempted=null;error=null;saved=true;}
   } catch { /* retain the mutation error and desired value */ }
 }
 async function save(enabled:boolean) {
   if (!canManage || $mutation.isPending || attempted !== null) return;
   attempted=enabled;error=null;saved=false;
   try { const result=await $mutation.mutateAsync(enabled);client.setQueryData(supervisorKey,result);
     if(result.enabled!==enabled) throw new Error('The server returned a different supervisor setting.');
     attempted=null;saved=true;
   } catch(e) {error=e;await check();}
 }
</script>
<Section id="agent-supervisor" title="Agent supervisor" description="External recovery for stalled work and missing handoffs across Codex, Claude and Grok.">
 {#if !$authStore.can('agent_messaging.read')}
  <p class="text-body-sm text-muted-foreground">Viewing supervision requires agent_messaging.read.</p>
 {:else if $query.isPending}<StateBlock state="loading" rows={2}/>
 {:else}
  {#if $query.isError}<StateBlock state="error" message={$query.data ? 'Supervisor information is stale. Refresh before changing it.' : 'Could not load the supervisor.'} onRetry={() => void check()}/>{/if}
  {#if $query.data}
   <div class="flex items-start justify-between gap-4 border-y py-3">
    <div class="space-y-1">
     <label for="agent-supervisor-toggle" class="text-body font-medium">Enable fleet supervision</label>
     <p id="supervisor-help" class="text-body-sm text-muted-foreground">Reminds after ten minutes without progress. Recovers the same native session up to five times within two hours per incident. Active tools and user questions are protected.</p>
     <p class="text-body-sm">{$query.isError ? 'Last confirmed state' : 'Effective state'}: <strong>{$query.data.effective ? 'Enabled' : 'Disabled'}</strong></p>
     {#if $query.data.enabled && !$query.data.effective}<p class="text-body-sm">Configured on; paused while agent messaging or the API is disabled.</p>{/if}
    </div>
    {#key `${$mutation.status}:${$query.data.enabled}`}
    <Switch id="agent-supervisor-toggle" checked={$query.data.enabled} disabled={!canManage || $mutation.isPending || $query.isError || $query.isFetching || attempted!==null} aria-describedby="supervisor-help" onCheckedChange={(v)=>void save(v)}/>
    {/key}
   </div>
   <p class="mt-2 text-body-sm text-muted-foreground">Changes save immediately. Turning this off stops supervisor recovery; accepted work continues. Automatic restart requires an upgraded wrapper and a persistent host.</p>
   {#if !canManage}<p class="text-body-sm text-muted-foreground">Read only. Changes require agent_messaging.manage.</p>{/if}
   {#if $mutation.isPending}<p role="status" class="text-body-sm">Saving… Waiting for confirmation.</p>
   {:else if error}<SaveState {error}/><p class="text-body-sm">Requested: {attempted ? 'Enabled' : 'Disabled'}. Check the server before retrying.</p><Button variant="outline" size="sm" onclick={()=>void check()}>Check current state</Button>
    {#if attempted !== null && !$query.isError && !$query.isFetching}<Button variant="outline" size="sm" onclick={()=>{const next=attempted;attempted=null;if(next!==null)void save(next);}}>Retry requested change</Button>{/if}
   {:else if saved}<SaveState saved/>{/if}
   <div class="mt-4 space-y-4">
    {#each ($query.data.states??[]).filter(w=>w.escalation || w.paused || ['working','waiting_agent','waiting_user'].includes(w.state)) as work (work.target)}
     <SupervisorStatus target={work.target} showTarget/>
    {:else}<p class="text-body-sm text-muted-foreground">No active supervised work or unresolved incidents.</p>{/each}
   </div>
  {/if}
 {/if}
</Section>
