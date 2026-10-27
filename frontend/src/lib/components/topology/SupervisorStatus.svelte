<script lang="ts">
 import { supervisorQuery, supervisorPause } from '$lib/api/supervisor';
 import { authStore } from '$lib/stores/auth';
 import { StateBlock, SaveState } from '$lib/components/page';
 import { Button } from '$lib/components/ui/button';
 let {target,showTarget=false}:{target:string;showTarget?:boolean}=$props();
 const query=supervisorQuery();
 const pause=supervisorPause();
 const work=$derived($query.data?.states?.find(w=>w.target===target));
 const labels:Record<string,string>={working:'Working',waiting_agent:'Waiting for an agent',waiting_user:'Waiting for user input',completed:'Completed',canceled:'Canceled'};
 const when=(value:string|null)=>value?new Date(value).toLocaleString():'—';
</script>
{#if $authStore.can('agent_messaging.read')}
 <section class="space-y-2 border-t pt-3" aria-label="Task supervision">
  <h3 class="text-body font-semibold">Task supervision</h3>
  {#if showTarget}<p class="break-all font-mono text-caption">{target}</p>{/if}
  {#if $query.isPending}<StateBlock state="loading" rows={2}/>
  {:else if $query.isError}<StateBlock state="error" message="Supervisor state could not be refreshed; displayed information may be stale." onRetry={()=>void $query.refetch()}/>{/if}
  {#if work}
   <p class="text-body-sm">{labels[work.state]??work.state}{work.paused ? ' · Recovery paused' : ''}</p>
   {#if work.escalation}<p role="status" class="break-words text-body-sm text-destructive">Needs attention: {work.escalation.replaceAll('_',' ')}</p>{/if}
   {#if work.reason}<p class="break-words text-body-sm">{work.reason}</p>{/if}
   <dl class="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)] text-body-sm">
    {#if work.waitingForAddressId}<dt>Waiting for</dt><dd class="break-all font-mono text-caption">agent:{work.waitingForAddressId}</dd>{/if}
    <dt>Last progress</dt><dd>{when(work.lastProgressAt)}</dd>
    <dt>Recovery attempts</dt><dd>{work.attempts} / 5</dd>
    <dt>Next attempt</dt><dd>{when(work.nextAttemptAt)}</dd>
    {#if work.deadlineAt}<dt>Recovery deadline</dt><dd>{when(work.deadlineAt)}</dd>{/if}
   </dl>
   {#if !work.watchdogId && ['working','waiting_agent'].includes(work.state)}<p class="text-body-sm text-muted-foreground">Monitoring handoffs. Automatic restart is not armed.</p>{/if}
   {#if !work.paused && ['working','waiting_agent','waiting_user'].includes(work.state)}<Button variant="outline" size="sm" disabled={!$authStore.can('agent_messaging.manage') || $query.isError || $pause.isPending} onclick={()=>void $pause.mutateAsync(work).catch(()=>{})}>Pause recovery</Button>{/if}
   {#if $pause.isError}<SaveState error={$pause.error}/>{:else if $pause.isSuccess}<SaveState saved/>{/if}
  {:else if $query.data}<p class="text-body-sm text-muted-foreground">{$query.data.effective ? 'No registered task for this agent.' : 'Fleet supervision is disabled.'}</p>{/if}
  {#each ($query.data?.dependencies??[]).filter(d=>`agent:${d.waiterAddressId}`===target) as edge (edge.id)}
   <p class="break-all text-body-sm">Pending handoff from agent:{edge.dependencyAddressId} · Work {edge.messageId??edge.workflowTaskId}</p>
  {/each}
 </section>
{/if}
