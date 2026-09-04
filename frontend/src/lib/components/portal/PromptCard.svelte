<script lang="ts">
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { clockTime } from "$lib/portal/browser";

  let { event, active, onanswer, readonly = false }: {
    event: EventRow;
    active: boolean;
    /** With an option, that option IS the answer. Without one, focus the box. */
    onanswer: (option?: string) => void;
    /** Read-only surfaces still show the question as open; they just cannot answer it. */
    readonly?: boolean;
  } = $props();

  const options = $derived(Array.isArray(event.payload.options) ? (event.payload.options as string[]) : []);
</script>

<article
  class="my-4 rounded-xl border px-4 py-3
         {active ? 'border-warning/30 bg-warning-muted' : 'border-border bg-muted/40'}"
>
  <p class="text-[11px] font-semibold uppercase tracking-[0.08em]
            {active ? 'text-warning-muted-foreground' : 'text-muted-foreground'}">
    Agent asks · {clockTime(event.created_at)}
  </p>
  <p class="mt-1 whitespace-pre-wrap text-body font-medium">{eventText(event)}</p>
  {#if options.length && active && !readonly}
    <div class="mt-2 flex flex-wrap gap-2">
      {#each options as option (option)}
        <button
          type="button"
          class="rounded-md border border-border bg-background px-2.5 py-1 text-caption transition
                 hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onclick={() => onanswer(option)}
        >{option}</button>
      {/each}
    </div>
  {/if}
</article>
