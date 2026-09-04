<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { clockTime } from "$lib/portal/browser";

  let { event }: { event: EventRow } = $props();

  // A force close records the note without delivering it; a cooperative close
  // queues it for the agent. Saying which is the whole reason this is its own
  // event type rather than a plain operator message.
  const forced = $derived(event.payload.delivery_status === "forced");
</script>

<article class="my-4 rounded-lg border border-warning/25 bg-warning-muted px-3 py-2">
  <p class="text-[11px] font-semibold uppercase tracking-[0.08em] text-warning-muted-foreground">
    {forced ? "Force ended" : "Close requested"} · {clockTime(event.created_at)}
  </p>
  <p class="mt-1 whitespace-pre-wrap text-body-sm">{eventText(event)}</p>
  {#if forced}
    <p class="mt-1 text-[11px] text-warning-muted-foreground">The agent was not able to receive this note.</p>
  {/if}
</article>
