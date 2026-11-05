<script lang="ts">
  /**
   * One instant. Relative by default ("3 minutes ago") with the exact local
   * time and its zone as accessible detail; `absolute` shows that zoned time
   * instead. `live` re-renders the relative text every 30 s (freshness lines).
   */
  import { formatDateTime, relativeTime, toDate } from "$lib/utils/format";
  import { cn } from "$lib/utils/cn";
  type Props = {
    value: Date | string | number | null | undefined;
    fallback?: string;
    absolute?: boolean;
    live?: boolean;
    class?: string;
  };
  let { value, fallback = "Unknown time", absolute = false, live = false, class: className }: Props = $props();
  let tick = $state(0);
  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => { tick += 1; }, 30_000);
    return () => clearInterval(timer);
  });
  const date = $derived(toDate(value));
  const exact = $derived(date ? formatDateTime(date) : "");
  const relative = $derived.by(() => {
    void tick;
    return date ? relativeTime(date) : "";
  });
</script>
{#if date}<time
    class={cn("tabular-nums", className)}
    datetime={date.toISOString()}
    title={absolute ? date.toISOString() : exact}
    aria-label={absolute ? undefined : `${relative}; ${exact}`}
  >{absolute ? exact : relative}</time>{:else}<span class={className}>{fallback}</span>{/if}
