<script lang="ts">
  /** A single-line row of key numbers. Replaces rows of stat cards. */
  import { cn } from "$lib/utils/cn";

  export type Stat = {
    label: string;
    value: string | number;
    tone?: "default" | "success" | "warning" | "danger";
    href?: string;
    hint?: string;
  };
  /** `tiles` gives each number its own card with the label underneath; `inline` is the compact single line. */
  let { items, class: className, variant = "inline" }: { items: Stat[]; class?: string; variant?: "inline" | "tiles" } = $props();
  const tones = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
  } as const;
</script>

{#if variant === "tiles"}
  <dl class={cn("grid grid-cols-2 gap-3 sm:flex sm:flex-wrap", className)}>
    {#each items as stat (stat.label)}
      <div class="flex min-w-36 flex-col gap-0.5 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-muted/40" title={stat.hint}>
        <dd class="order-1">
          {#if stat.href}
            <a href={stat.href} class={cn("text-3xl font-semibold leading-none tabular-nums hover:underline", tones[stat.tone ?? "default"])}>{stat.value}</a>
          {:else}
            <span class={cn("text-3xl font-semibold leading-none tabular-nums", tones[stat.tone ?? "default"])}>{stat.value}</span>
          {/if}
        </dd>
        <dt class="order-2 mt-1 text-body-sm text-muted-foreground">{stat.label}</dt>
        {#if stat.hint}<p class="order-3 text-caption text-muted-foreground">{stat.hint}</p>{/if}
      </div>
    {/each}
  </dl>
{:else}
  <dl class={cn("flex flex-wrap gap-x-6 gap-y-1 border-y py-2", className)}>
    {#each items as stat (stat.label)}
      <div class="flex items-baseline gap-1.5" title={stat.hint}>
        {#if stat.href}
          <dd class="order-1"><a href={stat.href} class={cn("text-lg font-semibold tabular-nums hover:underline", tones[stat.tone ?? "default"])}>{stat.value}</a></dd>
        {:else}
          <dd class={cn("order-1 text-lg font-semibold tabular-nums", tones[stat.tone ?? "default"])}>{stat.value}</dd>
        {/if}
        <dt class="order-2 text-body-sm text-muted-foreground">{stat.label}</dt>
      </div>
    {/each}
  </dl>
{/if}
