<script lang="ts">
  /** Read view of one wake-up: its prompt and the latest executions. */
  import { Button } from "$lib/components/ui/button";
  import { StateBlock } from "$lib/components/page";
  import type { ScheduleDetail } from "$lib/api/schedules";

  type Props = {
    detail: ScheduleDetail | undefined;
    error?: string | null;
    agentLabel: (address: string) => string;
    canManage: boolean;
    onEdit: () => void;
  };
  let { detail, error, agentLabel, canManage, onEdit }: Props = $props();
</script>

{#if error}
  <StateBlock state="error" message={error} />
{:else if detail}
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-2">
      <span class="text-body">{agentLabel(detail.schedule.target)}</span>
      {#if canManage}<Button variant="outline" onclick={onEdit}>Edit</Button>{/if}
    </div>
    <pre class="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-body-sm">{detail.schedule.prompt}</pre>
    <p class="text-caption text-muted-foreground">Created by {detail.schedule.created_by}; last changed by {detail.schedule.updated_by}.</p>
    <h3 class="text-h3">Latest executions</h3>
    <p class="text-caption text-muted-foreground">Accepted means received, not finished. Recovery after an interrupted run may repeat actions.</p>
    {#if !detail.runs.length}<p class="text-body-sm">No executions yet.</p>{/if}
    {#each detail.runs as run (run.id)}
      <div class="flex flex-wrap justify-between gap-2 border-t py-2 text-body-sm">
        <span>{run.due_at}</span>
        <span>{run.status} · task: {run.task_result_status ?? "unknown"} · {run.recovery_count} recoveries</span>
        {#if run.warning_at}<span class="text-warning-muted-foreground">Repeated recovery failures</span>{/if}
        {#if run.delivery_reason}<span>{run.delivery_reason}</span>{/if}
        {#if run.last_error}<span class="text-muted-foreground">{run.last_error}</span>{/if}
        {#if run.status === "capacity_wait" || run.status === "recovering"}<span>Retry: {run.next_attempt_at}</span>{/if}
      </div>
    {/each}
  </div>
{:else}
  <StateBlock state="loading" rows={3} />
{/if}
