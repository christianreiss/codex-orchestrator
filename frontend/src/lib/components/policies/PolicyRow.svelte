<script lang="ts">
  /**
   * One fleet setting as a flat row: plain label, one line of help and the
   * control on the right. The canonical term (`policy-terms.ts`, keyed by `id`)
   * lives inside the "More" disclosure, not beside the label. `stacked` puts
   * the control (a small form) under the text instead of beside it.
   */
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import HostOverrideBadge from "./HostOverrideBadge.svelte";
  import { policyTerm } from "./policy-terms";

  type Props = {
    id: string;
    label: string;
    /** Id of the control the label belongs to; omit for a form with several controls. */
    controlId?: string;
    help: string;
    /** Longer explanation behind a "More" disclosure. */
    details?: string;
    stacked?: boolean;
    /** Hosts that override this setting; leave out when hosts cannot (or it is not yet known). */
    overrideCount?: number | null;
    /** What a host overrides, for the badge's accessible name. */
    overrideNoun?: string;
    control?: Snippet;
    children?: Snippet;
    class?: string;
  };
  let { id, label, controlId, help, details, stacked = false, overrideCount, overrideNoun, control, children, class: className }: Props = $props();
  const term = $derived(policyTerm(id));
</script>

<div {id} class={cn("scroll-mt-24 py-3", className)}>
  <div class={stacked ? "space-y-3" : "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 sm:flex-nowrap"}>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-baseline gap-x-2">
        {#if controlId}
          <label for={controlId} class="text-body font-medium">{label}</label>
        {:else}
          <h3 class="text-body font-medium">{label}</h3>
        {/if}
        <HostOverrideBadge count={overrideCount} noun={overrideNoun} />
      </div>
      <p class="text-body-sm text-muted-foreground">{help}</p>
    </div>
    {#if control}<div class="flex shrink-0 items-center">{@render control()}</div>{/if}
  </div>
  {@render children?.()}
  {#if details || term}
    <details class="mt-1 text-body-sm text-muted-foreground">
      <summary class="w-fit cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">More</summary>
      {#if term}<p class="mt-1">Also known as <span class="font-medium text-foreground">{term}</span>.</p>{/if}
      {#if details}<p class="mt-1 max-w-2xl leading-relaxed">{details}</p>{/if}
    </details>
  {/if}
</div>
