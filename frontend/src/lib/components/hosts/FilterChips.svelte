<script lang="ts">
  import { cn } from "$lib/utils/cn";
  import type { HostFilterId } from "$lib/api/hosts";

  type Props = {
    value: HostFilterId;
    counts?: Partial<Record<HostFilterId, number>>;
    onchange?: (value: HostFilterId) => void;
    class?: string;
  };

  let { value, counts, onchange, class: className }: Props = $props();

  const chips: Array<{ id: HostFilterId; label: string }> = [
    { id: "all", label: "All" },
    { id: "online", label: "Online" },
    { id: "offline", label: "Offline" },
    { id: "secure", label: "Secure" },
    { id: "insecure", label: "Insecure" },
    { id: "unprovisioned", label: "Unprovisioned" },
    { id: "vip", label: "VIP" },
    { id: "roaming", label: "Roaming" },
  ];
</script>

<div class={cn("flex flex-wrap items-center gap-2", className)} role="tablist" aria-label="Host filters">
  {#each chips as chip (chip.id)}
    {@const isActive = chip.id === value}
    {@const count = counts?.[chip.id]}
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      class={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
      onclick={() => onchange?.(chip.id)}
    >
      {chip.label}
      {#if typeof count === "number"}
        <span
          class={cn(
            "rounded-full px-1.5 text-[10px]",
            isActive ? "bg-primary-foreground/15" : "bg-muted",
          )}
        >
          {count}
        </span>
      {/if}
    </button>
  {/each}
</div>
