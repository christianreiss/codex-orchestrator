<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { clockTime } from "$lib/portal/browser";

  // Session boundaries stay visible as calm timeline markers, even when
  // nearby routine progress collapses.
  let { event }: { event: EventRow } = $props();

  const tone = $derived(
    event.type === "failed" ? "text-destructive" : event.type === "completed" ? "text-success" : "text-muted-foreground",
  );
</script>

<p class="my-3 text-center text-[11px] font-medium {tone}">
  {eventText(event)} · {clockTime(event.created_at)}
</p>
