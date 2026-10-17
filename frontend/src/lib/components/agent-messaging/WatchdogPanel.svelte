<script lang="ts">
  /** Per-address watchdog: resume the same session after a crash, hang or capacity failure. */
  import { writable } from "svelte/store";
  import { toast } from "svelte-sonner";
  import { watchdogsQuery, watchdogMutation } from "$lib/api/watchdogs";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";

  let { target, canManage, eligible }: { target: string; canManage: boolean; eligible: boolean } = $props();

  const targetStore = writable("");
  $effect(() => targetStore.set(target));
  const query = watchdogsQuery(targetStore);
  const mutation = watchdogMutation();

  const LIVE = ["watching", "recovering", "capacity_wait"];
  let open = $state(false);
  let taskKey = $state("");
  let continuation = $state("");
  let hours = $state(2);
  let minutes = $state(10);

  const current = $derived($query.data?.watchdogs.find((w) => LIVE.includes(w.status)) ?? $query.data?.watchdogs[0]);
  const active = $derived(!!current && LIVE.includes(current.status));
  const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "none");

  async function enable() {
    try {
      await $mutation.mutateAsync({
        body: {
          target,
          task_key: taskKey.trim(),
          continuation: continuation.trim(),
          duration_seconds: Math.round(hours * 3600),
          progress_timeout_seconds: Math.round(minutes * 60),
        },
      });
      open = false;
      toast.success("Watchdog enabled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not enable watchdog");
    }
  }
  async function disable() {
    if (!current) return;
    try {
      await $mutation.mutateAsync({ id: current.id, body: { version: current.version } });
      toast.success("Recovery disabled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disable watchdog");
    }
  }
</script>

<div class="border-t border-border/60 bg-muted/20 px-3 py-2 text-caption" data-testid="watchdog-panel">
  <div class="flex flex-wrap items-center gap-3">
    <strong>Watchdog</strong>
    {#if $query.isError}
      <span class="text-destructive">Status unavailable</span>
    {:else if current}
      <span>{current.status} · {current.recovery_count} recovery attempts</span>
      <span>Until {when(current.deadline_at)}</span>
      <span>Next wake: {when(current.next_wake_at)}</span>
      {#if current.last_error}<span>{current.last_error}</span>{/if}
    {:else}
      <span class="text-muted-foreground">Off</span>
    {/if}
    {#if canManage}
      {#if active}
        <Button size="sm" variant="outline" disabled={$mutation.isPending} onclick={disable}>Disable watchdog</Button>
      {:else}
        <Button size="sm" variant="outline" disabled={!eligible} onclick={() => (open = !open)}>Enable watchdog</Button>
      {/if}
    {/if}
  </div>
  {#if current}
    <p class="mt-1 text-muted-foreground">Last wake: {when(current.last_wake_at)} · Last progress: {when(current.last_progress_at)} · Keep-alive: 15 seconds</p>
  {/if}
  {#if open}
    <form class="mt-3 grid max-w-xl gap-2" onsubmit={(event) => { event.preventDefault(); void enable(); }}>
      <label>Task key<Input bind:value={taskKey} required placeholder="Stable name for this task" /></label>
      <label>Continue this authorized task<Textarea bind:value={continuation} required placeholder="Task and acceptance criteria" rows={3} /></label>
      <div class="flex gap-3">
        <label>Protection (hours)<Input type="number" min={1 / 60} max={168} step="any" bind:value={hours} required /></label>
        <label>No progress (minutes)<Input type="number" min={1} max={10080} bind:value={minutes} required /></label>
      </div>
      <p class="text-muted-foreground">Resumes the same session after capacity, crash or hang. Stops at task completion, a clean client exit, user stop or the deadline. Timed wake-ups stay active. Recovery after an ambiguous crash may repeat effects.</p>
      <Button type="submit" disabled={$mutation.isPending || !taskKey.trim() || !continuation.trim()}>Enable protection</Button>
    </form>
  {/if}
</div>
