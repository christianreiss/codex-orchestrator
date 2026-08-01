<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import StatusLine from "./StatusLine.svelte";

  // Collapsing these runs is what physically stops progress chatter from
  // burying an attention notice.
  let { events }: { events: EventRow[] } = $props();
  let open = $state(false);
</script>

{#if open}
  {#each events as event (event.cursor)}
    <StatusLine {event} />
  {/each}
  <div class="my-1 text-center">
    <button
      type="button"
      class="rounded px-2 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground
             focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onclick={() => (open = false)}
    >Hide {events.length} status updates</button>
  </div>
{:else}
  <div class="my-1 text-center">
    <button
      type="button"
      class="rounded px-2 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground
             focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onclick={() => (open = true)}
      aria-expanded="false"
    >⋯ {events.length} status updates</button>
  </div>
{/if}
