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
  let { items, class: className }: { items: Stat[]; class?: string } = $props();
  const tones = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
  } as const;
</script>

<dl class={cn("flex flex-wrap gap-x-6 gap-y-1 border-y py-2", className)}>
  {#each items as stat (stat.label)}
    <div class="flex items-baseline gap-1.5" title={stat.hint}>
      {#if stat.href}
        <a href={stat.href} class={cn("text-lg font-semibold tabular-nums hover:underline", tones[stat.tone ?? "default"])}>{stat.value}</a>
      {:else}
        <dd class={cn("order-1 text-lg font-semibold tabular-nums", tones[stat.tone ?? "default"])}>{stat.value}</dd>
      {/if}
      <dt class="order-2 text-body-sm text-muted-foreground">{stat.label}</dt>
    </div>
  {/each}
</dl>
