<script lang="ts">
 import { writable } from 'svelte/store';
 import { watchdogsQuery,watchdogMutation } from '$lib/api/watchdogs';
 import { Button } from '$lib/components/ui/button';
 import { Input } from '$lib/components/ui/input';
 import { toast } from 'svelte-sonner';
 let {target,canManage,eligible}:{target:string;canManage:boolean;eligible:boolean}=$props();
 const targetStore=writable("");$effect(()=>targetStore.set(target));
 const query=watchdogsQuery(targetStore),mutation=watchdogMutation();
 let open=$state(false),taskKey=$state(''),continuation=$state(''),hours=$state(2),minutes=$state(10);
 const current=$derived($query.data?.watchdogs.find(w=>['watching','recovering','capacity_wait'].includes(w.status)) ?? $query.data?.watchdogs[0]);
 const active=$derived(!!current && ['watching','recovering','capacity_wait'].includes(current.status));
 async function enable(){try {await $mutation.mutateAsync({body:{target,task_key:taskKey.trim(),continuation:continuation.trim(),duration_seconds:Math.round(hours*3600),progress_timeout_seconds:Math.round(minutes*60)}});open=false;toast.success('Watchdog enabled');}catch(e){toast.error(e instanceof Error?e.message:'Could not enable watchdog');}}
 async function disable(){if(!current)return;try{await $mutation.mutateAsync({id:current.id,body:{version:current.version}});toast.success('Recovery disabled');}catch(e){toast.error(e instanceof Error?e.message:'Could not disable watchdog');}}
</script>
<div class="border-t border-border px-3 py-2 text-xs" data-testid="watchdog-panel">
 <div class="flex flex-wrap items-center gap-3">
  <strong>Watchdog</strong>
  {#if $query.isError}<span class="text-destructive">Status unavailable</span>{:else if current}
   <span>{current.status} · {current.recovery_count} recovery attempts</span>
   <span>Until {new Date(current.deadline_at).toLocaleString()}</span>
   <span>Next wake: {current.next_wake_at ? new Date(current.next_wake_at).toLocaleString() : 'none'}</span>
   {#if current.last_error}<span>{current.last_error}</span>{/if}
  {:else}<span class="text-muted-foreground">Off</span>{/if}
  {#if canManage}
   {#if active}<Button size="sm" variant="outline" disabled={$mutation.isPending} onclick={disable}>Disable watchdog</Button>
   {:else}<Button size="sm" variant="outline" disabled={!eligible} onclick={()=>open=!open}>Enable watchdog</Button>{/if}
  {/if}
 </div>
 {#if current}<p class="mt-1 text-muted-foreground">Last wake: {current.last_wake_at ? new Date(current.last_wake_at).toLocaleString() : 'none'} · Last progress: {new Date(current.last_progress_at).toLocaleString()} · Keep-alive: 15 seconds</p>{/if}
 {#if open}
 <form class="mt-3 grid max-w-xl gap-2" onsubmit={(e)=>{e.preventDefault();void enable();}}>
  <label>Task key<Input bind:value={taskKey} required placeholder="Stable name for this task" /></label>
  <label>Continue this authorized task<textarea class="mt-1 min-h-20 w-full rounded-md border bg-background p-2" bind:value={continuation} required placeholder="Task and acceptance criteria"></textarea></label>
  <div class="flex gap-3"><label>Protection (hours)<Input type="number" min={1/60} max={168} step="any" bind:value={hours} required /></label><label>No progress (minutes)<Input type="number" min={1} max={10080} bind:value={minutes} required /></label></div>
  <p class="text-muted-foreground">Resumes the same session after capacity, crash or hang. Stops at task completion or the deadline. Recovery after an ambiguous crash may repeat effects.</p>
  <Button type="submit" disabled={$mutation.isPending || !taskKey.trim() || !continuation.trim()}>Enable protection</Button>
 </form>
 {/if}
</div>
