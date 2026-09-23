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

<article class="my-3 flex flex-col items-start">
  <p class="mb-0.5 pl-3 text-[11px] {active ? 'text-warning-muted-foreground' : 'text-muted-foreground'}">
    Asked · {clockTime(event.created_at)}
  </p>
  <p
    class="max-w-[min(88%,40rem)] whitespace-pre-wrap rounded-[1.1rem] border px-3.5 py-2 text-body
           {active ? 'border-warning/30 bg-warning-muted' : 'border-border bg-muted/40'}"
  >{eventText(event)}</p>
  {#if options.length && active && !readonly}
    <div class="mt-1.5 flex flex-wrap gap-1.5">
      {#each options as option (option)}
        <button
          type="button"
          class="rounded-full border border-primary/40 bg-background px-3 py-1 text-caption text-primary transition
                 hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onclick={() => onanswer(option)}
        >{option}</button>
      {/each}
    </div>
  {/if}
</article>
