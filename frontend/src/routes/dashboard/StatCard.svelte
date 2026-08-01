<script lang="ts">
  import { cn } from "$lib/utils/cn";
  import type { Snippet } from "svelte";

  type Props = {
    label: string;
    value: string | number;
    hint?: string | null;
    /** Optional icon rendered to the right of the value. */
    icon?: Snippet;
    /** Optional compact detail rendered beside the primary value. */
    breakdown?: Snippet;
    class?: string;
    loading?: boolean;
  };

  let {
    label,
    value,
    hint,
    icon,
    breakdown,
    class: className,
    loading = false,
  }: Props = $props();
</script>

<div
  class={cn(
    "rounded-md border border-border/75 bg-card p-3",
    className,
  )}
>
  <div class="flex items-start justify-between gap-2">
    <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
    {#if icon}
      <span class="text-muted-foreground">{@render icon()}</span>
    {/if}
  </div>
  <div class="mt-2 flex items-end justify-between gap-3">
    {#if loading}
      <div class="h-7 w-16 animate-pulse rounded bg-muted"></div>
    {:else}
      <span class="text-2xl font-semibold tabular-nums leading-none">{value}</span>
    {/if}
    {#if breakdown}
      <div class="shrink-0">{@render breakdown()}</div>
    {/if}
  </div>
  {#if hint}
    <p class="mt-1 text-xs text-muted-foreground">{hint}</p>
  {/if}
</div>
