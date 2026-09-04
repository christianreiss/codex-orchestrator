<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";

  // Deliberately recessive: no border, no background, no bubble. Status events
  // are context, not content.
  let { event }: { event: EventRow } = $props();
</script>

<p
  class="my-0.5 text-center text-[11px] leading-relaxed text-muted-foreground/70
         {event.type === 'terminal_block' ? 'font-mono' : ''}"
>{eventText(event)}</p>
