<script lang="ts">
  import AlertTriangleIcon from "@lucide/svelte/icons/triangle-alert";
  import type { EventRow } from "$lib/portal/types";
  import { eventText } from "$lib/portal/grouping";
  import { clockTime, shortAge } from "$lib/portal/browser";

  let {
    event,
    outstanding,
    now,
    onreply,
    readonly = false,
  }: {
    event: EventRow;
    outstanding: boolean;
    now: number;
    onreply: (option?: string) => void;
    /**
     * Console surfaces can see a notice but cannot answer it: replying writes an
     * `agent_messages` row, which is keyed to a portal user. `outstanding` stays
     * truthful either way -- demoting the styling instead would hide the one
     * event that most needs a human from the operator most able to find one.
     */
    readonly?: boolean;
  } = $props();
</script>

{#if outstanding}
  <!--
    Full width, not a bubble, not centred, not dashed. The previous rendering
    put this in the same grey dashed centred style as `progress`, which is why
    the one event that demands a human looked like background noise.
  -->
  <article
    class="my-4 rounded-xl border border-destructive/25 border-l-4 border-l-destructive
           bg-destructive-muted p-4 shadow-pop"
  >
    <p class="flex flex-wrap items-center gap-x-2 text-[11px] font-semibold uppercase tracking-[0.08em]
              text-destructive-muted-foreground">
      <AlertTriangleIcon class="h-3.5 w-3.5" />
      Needs you
      <span class="font-normal normal-case tracking-normal opacity-80">
        {clockTime(event.created_at)} · still waiting {shortAge(event.created_at, now)}
      </span>
    </p>
    <p class="mt-2 whitespace-pre-wrap text-body font-medium">{eventText(event)}</p>
    {#if !readonly}
      <button
        type="button"
        class="mt-3 rounded-md bg-destructive px-3 py-1.5 text-caption font-semibold text-destructive-foreground
               transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onclick={() => onreply()}
      >Reply</button>
    {/if}
  </article>
{:else}
  <!-- Already dealt with: keep it in the record, stop it shouting. -->
  <article class="my-3 border-l-2 border-border bg-muted/40 py-2 pl-3 pr-2">
    <p class="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      Needed you · {clockTime(event.created_at)}
    </p>
    <p class="mt-1 whitespace-pre-wrap text-body-sm text-muted-foreground">{eventText(event)}</p>
  </article>
{/if}
