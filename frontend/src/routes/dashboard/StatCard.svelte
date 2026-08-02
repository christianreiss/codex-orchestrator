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
    /** Persona-colored left edge; "neutral" renders no edge. */
    accent?: "codex" | "claude" | "neutral";
  };

  let {
    label,
    value,
    hint,
    icon,
    breakdown,
    class: className,
    loading = false,
    accent = "neutral",
  }: Props = $props();

  const ACCENT_EDGE: Record<"codex" | "claude" | "neutral", string> = {
    codex: "bg-persona-codex",
    claude: "bg-persona-claude",
    neutral: "",
  };
</script>

<div
  class={cn(
    "relative overflow-hidden rounded-md border border-border/75 bg-card p-3",
    className,
  )}
>
  {#if accent !== "neutral"}
    <span class={cn("absolute inset-y-0 left-0 w-0.5", ACCENT_EDGE[accent])} aria-hidden="true"></span>
  {/if}
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
      <span class="text-2xl font-mono font-semibold tabular-nums tracking-tight leading-none">{value}</span>
    {/if}
    {#if breakdown}
      <div class="shrink-0">{@render breakdown()}</div>
    {/if}
  </div>
  {#if hint}
    <p class="mt-1 text-xs text-muted-foreground">{hint}</p>
  {/if}
</div>
