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

<div class="my-3 text-center text-[11px] text-warning-muted-foreground">
  <p class="font-semibold">{forced ? "Force ended" : "Close requested"} · {clockTime(event.created_at)}</p>
  <p class="mx-auto mt-0.5 max-w-md whitespace-pre-wrap text-muted-foreground">{eventText(event)}</p>
  {#if forced}<p class="mt-0.5">The agent was not able to receive this note.</p>{/if}
</div>
