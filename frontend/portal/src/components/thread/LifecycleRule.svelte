<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { clockTime } from "../../lib/browser";

  // Session boundaries are structural, so they read as a rule across the
  // thread rather than another line of chatter. Never collapsed.
  let { event }: { event: EventRow } = $props();

  const tone = $derived(
    event.type === "failed" ? "text-destructive" : event.type === "completed" ? "text-success" : "text-muted-foreground",
  );
</script>

<div class="relative my-4 flex items-center justify-center">
  <span class="absolute inset-x-0 top-1/2 border-t border-border" aria-hidden="true"></span>
  <span class="relative bg-background px-3 text-[11px] font-medium {tone}">
    {eventText(event)} · {clockTime(event.created_at)}
  </span>
</div>
