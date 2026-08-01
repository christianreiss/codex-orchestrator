<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    until: string | null | undefined;
    class?: string;
  };
  let { until, class: className }: Props = $props();

  let now = $state(Date.now());
  let interval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    interval = setInterval(() => {
      now = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  const targetTs = $derived(until ? Date.parse(until) : NaN);
  const remainingSec = $derived(
    Number.isNaN(targetTs) ? null : Math.max(0, Math.floor((targetTs - now) / 1000)),
  );
  const active = $derived(remainingSec !== null && remainingSec > 0);
  const display = $derived.by(() => {
    if (remainingSec === null) return "—";
    if (remainingSec <= 0) return "expired";
    const m = Math.floor(remainingSec / 60);
    const s = remainingSec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return `${h}h ${mm}m`;
    }
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  });
</script>

{#if active}
  <span
    class={cn(
      "inline-flex items-center gap-1 rounded-md border border-warning/25 bg-warning-muted px-1.5 py-0.5 font-mono text-xs text-warning-muted-foreground",
      className,
    )}
  >
    {display}
  </span>
{:else}
  <span class={cn("text-muted-foreground", className)}>—</span>
{/if}
