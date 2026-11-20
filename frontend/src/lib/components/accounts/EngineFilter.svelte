<script lang="ts">
  /**
   * Always-visible segmented control that scopes the account list to one
   * engine. Only engines switched on fleet-wide are offered; the caller passes
   * `$fleet.enabled`.
   */
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { cn } from "$lib/utils/cn";

  type Props = { value: Engine | "all"; engines: readonly Engine[]; onChange: (next: Engine | "all") => void };
  let { value, engines, onChange }: Props = $props();
  const options = $derived([{ id: "all" as const, label: "All" }, ...engines.map((id) => ({ id, label: ENGINE_META[id].account }))]);
</script>

<div class="inline-flex min-h-9 max-w-full flex-wrap items-center gap-0.5 rounded-md border bg-muted/40 p-0.5" role="group" aria-label="Filter by engine">
  {#each options as option (option.id)}
    <button
      type="button"
      aria-pressed={value === option.id}
      class={cn(
        "inline-flex min-h-8 items-center gap-1 rounded-md px-3 text-body-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        value === option.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
      onclick={() => onChange(option.id)}
    >
      {option.label}
    </button>
  {/each}
</div>
