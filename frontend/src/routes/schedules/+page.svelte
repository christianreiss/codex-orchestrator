<script lang="ts">
 import { writable } from 'svelte/store';
 import { toast } from 'svelte-sonner';
 import { useQueryClient } from '@tanstack/svelte-query';
 import PageHeader from '$lib/components/layout/PageHeader.svelte';
 import { Button } from '$lib/components/ui/button';
 import { Input } from '$lib/components/ui/input';
 import { Textarea } from '$lib/components/ui/textarea';
 import { authStore } from '$lib/stores/auth';
 import { agentMessagingAddressesQuery } from '$lib/api/agentMessaging';
 import { scheduleQuery, schedulesQuery, scheduleMutation, scheduleKeys, type Schedule } from '$lib/api/schedules';
 import { relativeTime } from '$lib/utils/format';

 const client=useQueryClient();
 const after=writable<string|undefined>();
 const list=schedulesQuery(after);
 const addresses=agentMessagingAddressesQuery();
 const selected=writable('');
 const detail=scheduleQuery(selected);
 const canManage=$derived($authStore.can('agent_messaging.manage'));
 let editing=$state(false);
 let id=$state(''), version=$state(0), name=$state(''), target=$state(''), prompt=$state('');
 let kind=$state<Schedule['kind']>('interval'), at=$state(''), cron=$state('0 9 * * *'), interval=$state(5);
 let timezone=$state('Europe/Berlin'), persistent=$state(false), timeout=$state<number|undefined>(), enabled=$state(true);
 const mutation=scheduleMutation(()=>{ editing=false; toast.success('Schedule saved'); },e=>toast.error(e.message));
 const rows=$derived($list.data?.schedules ?? []);
 function newSchedule() { id=''; version=0; name=''; target=''; prompt=''; kind='interval'; at=''; cron='0 9 * * *'; interval=5; timezone='Europe/Berlin'; persistent=false; timeout=undefined; enabled=true; editing=true; }
 function edit(row: Schedule) {
  id=row.id; version=row.version; name=row.name; target=row.target; prompt=row.prompt ?? ''; kind=row.kind;
  at=row.at ?? ''; cron=row.cron ?? '0 9 * * *'; interval=row.interval_minutes ?? 5;
  timezone=row.timezone; persistent=row.persistent; timeout=row.progress_timeout_seconds ?? undefined; enabled=row.enabled; editing=true;
 }
 function save(event: SubmitEvent) {
  event.preventDefault();
  $mutation.mutate({ method:id ? 'PATCH' : 'POST', id:id || undefined, body: {
   ...(id ? {version} : {}), name,target,prompt,kind, at:kind==='once' ? at : null,
   cron:kind==='cron' ? cron : null, interval_minutes:kind==='interval' ? interval : null,
   timezone, enabled, persistent, progress_timeout_seconds:persistent ? timeout : null,
  }});
 }
 function pause(row: Schedule) { $mutation.mutate({method:'PATCH',id:row.id,body:{version:row.version,enabled:!row.enabled}}); }
 function remove(row: Schedule) { $mutation.mutate({method:'DELETE',id:row.id,body:{version:row.version}}); $selected=''; }
 const field='rounded-md border border-input bg-background px-3 py-2 text-sm';
</script>

<PageHeader title="Wake / Cron" subtitle="Scheduled prompts and optional persistent session recovery" />
<div class="space-y-5">
 <div class="flex flex-wrap items-center gap-3">
  {#if canManage}<Button onclick={newSchedule}>Create schedule</Button>{/if}
  <Button variant="outline" onclick={()=>client.invalidateQueries({queryKey:scheduleKeys.all})}>Refresh</Button>
  <p class="text-sm text-muted-foreground">Regular schedules wait for a receiver. Persistent recovery resumes the same session.</p>
 </div>
 {#if $list.error}<p role="alert" class="text-destructive">{$list.error.message}</p>{/if}
 {#if $list.isPending}<p>Loading schedules…</p>{:else if !rows.length}<p class="text-muted-foreground">No schedules on this page.</p>{/if}
 <div class="overflow-x-auto rounded-lg border">
  <table class="w-full text-left text-sm">
   <thead class="bg-muted/50"><tr><th class="p-3">Schedule</th><th class="p-3">Target</th><th class="p-3">Timing</th><th class="p-3">Next wake</th><th class="p-3">Recovery</th><th class="p-3">Actions</th></tr></thead>
   <tbody>{#each rows as row (row.id)}<tr class="border-t">
    <td class="p-3 font-medium">{row.name}<span class="block text-xs text-muted-foreground">{row.enabled ? 'Enabled' : 'Paused'}</span></td>
    <td class="max-w-64 break-all p-3 text-xs">{row.target}</td>
    <td class="p-3">{row.kind==='interval' ? `Every ${row.interval_minutes} min` : row.kind==='cron' ? row.cron : 'Once'}<span class="block text-xs text-muted-foreground">{row.timezone}</span></td>
    <td class="p-3" title={row.next_due_at ?? ''}>{row.next_due_at ? relativeTime(row.next_due_at) : 'No further wake'}</td>
    <td class="p-3">{row.persistent ? `On · ${row.progress_timeout_seconds}s timeout` : 'Off'}</td>
    <td class="p-3"><div class="flex flex-wrap gap-2"><Button size="sm" variant="outline" onclick={()=>$selected=row.id}>View</Button>{#if canManage}<Button size="sm" variant="outline" disabled={$mutation.isPending} onclick={()=>pause(row)}>{row.enabled ? 'Pause' : 'Enable'}</Button><Button size="sm" variant="destructive" disabled={$mutation.isPending} onclick={()=>remove(row)}>Delete</Button>{/if}</div></td>
   </tr>{/each}</tbody>
  </table>
 </div>
 <div class="flex gap-2">{#if $after}<Button variant="outline" onclick={()=>$after=undefined}>First page</Button>{/if}{#if $list.data?.next_cursor}<Button variant="outline" onclick={()=>$after=$list.data!.next_cursor!}>Next page</Button>{/if}</div>
 {#if $selected}
  <section class="space-y-3 rounded-lg border p-4">
   {#if $detail.error}<p role="alert" class="text-destructive">{$detail.error.message}</p>{:else if $detail.data}
    <div class="flex items-center justify-between"><h2 class="font-semibold">{$detail.data.schedule.name}</h2>{#if canManage}<Button variant="outline" onclick={()=>edit($detail.data!.schedule)}>Edit</Button>{/if}</div>
    <pre class="whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm">{$detail.data.schedule.prompt}</pre>
    <p class="text-xs text-muted-foreground">Created by {$detail.data.schedule.created_by}; last changed by {$detail.data.schedule.updated_by}.</p>
    <h3 class="font-medium">Latest executions</h3>
    <p class="text-xs text-muted-foreground">Accepted means received, not finished. Recovery after an interrupted run may repeat actions.</p>
    {#if !$detail.data.runs.length}<p class="text-sm">No executions yet.</p>{/if}
    {#each $detail.data.runs as run (run.id)}<div class="flex flex-wrap justify-between gap-2 border-t py-2 text-sm"><span>{run.due_at}</span><span>{run.status} · {run.recovery_count} recoveries</span>{#if run.last_error}<span class="text-muted-foreground">{run.last_error}</span>{/if}{#if run.status==='capacity_wait' || run.status==='recovering'}<span>Retry: {run.next_attempt_at}</span>{/if}</div>{/each}
   {:else}<p>Loading execution history…</p>{/if}
  </section>
 {/if}
 {#if editing && canManage}
  <form onsubmit={save} class="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
   <h2 class="font-semibold md:col-span-2">{id ? 'Edit schedule' : 'New schedule'}</h2>
   <label class="space-y-1 text-sm">Name<Input bind:value={name} required maxlength={120}/></label>
   <label class="space-y-1 text-sm">Target agent<select class={field+' w-full'} bind:value={target} required><option value="">Choose an agent</option>{#each $addresses.data?.addresses ?? [] as agent}<option value={agent.address}>{agent.alias ?? agent.username} · {agent.engine} · {agent.fqdn ?? agent.host_id}</option>{/each}</select></label>
   <label class="space-y-1 text-sm md:col-span-2">Prompt<Textarea bind:value={prompt} required maxlength={30000}/></label>
   <label class="space-y-1 text-sm">Timing<select class={field+' w-full'} bind:value={kind}><option value="once">Once</option><option value="interval">Every X minutes</option><option value="cron">Cron</option></select></label>
   {#if kind==='once'}<label class="space-y-1 text-sm">Time (RFC3339, including offset)<Input bind:value={at} placeholder="2026-10-09T09:00:00+02:00" required/></label>{:else if kind==='interval'}<label class="space-y-1 text-sm">Interval in minutes<Input type="number" min={1} max={525600} bind:value={interval} required/></label>{:else}<label class="space-y-1 text-sm">Cron expression<Input bind:value={cron} required placeholder="0 9 * * *"/></label>{/if}
   <label class="space-y-1 text-sm">Timezone<Input bind:value={timezone} required/></label>
   <label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={enabled}/> Enabled</label>
   <div class="space-y-2 rounded-md bg-muted/50 p-3 md:col-span-2"><label class="flex items-center gap-2 text-sm"><input type="checkbox" bind:checked={persistent}/> Persistent recovery — explicitly resume after crash, hang or capacity failure</label><p class="text-xs text-muted-foreground">Off by default. Repeating alone does not enable recovery. Requires a known native session and an active host worker. Missing transcripts block recovery.</p>{#if persistent}<label class="block space-y-1 text-sm">Progress timeout in seconds<Input type="number" min={60} max={604800} bind:value={timeout} required/><span class="text-xs text-muted-foreground">After this interval without observed progress, the Linux supervisor may stop its own process and resume the session. Active child tools prevent a timeout.</span></label>{/if}</div>
   <div class="flex gap-2 md:col-span-2"><Button type="submit" disabled={$mutation.isPending}>{$mutation.isPending ? 'Saving…' : 'Save'}</Button><Button type="button" variant="outline" onclick={()=>editing=false}>Cancel</Button></div>
  </form>
 {/if}
</div>
