<script lang="ts">
  /** Always-visible segmented control that scopes the account list to one engine. */
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";
  import { cn } from "$lib/utils/cn";

  type Props = { value: Engine | "all"; isEnabled: (engine: Engine) => boolean; onChange: (next: Engine | "all") => void };
  let { value, isEnabled, onChange }: Props = $props();
  const options = $derived([{ id: "all" as const, label: "All" }, ...ENGINES.map((id) => ({ id, label: ENGINE_META[id].account }))]);
</script>

<div class="inline-flex min-h-9 max-w-full flex-wrap items-center gap-0.5 rounded-md border bg-muted/40 p-0.5" role="group" aria-label="Filter by engine">
  {#each options as option (option.id)}
    {@const off = option.id !== "all" && !isEnabled(option.id)}
    <button
      type="button"
      aria-pressed={value === option.id}
      title={off ? `${option.label} is disabled fleet-wide` : undefined}
      class={cn(
        "inline-flex min-h-8 items-center gap-1 rounded-md px-3 text-body-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        value === option.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
      onclick={() => onChange(option.id)}
    >
      {option.label}{#if off}<span class="text-caption text-warning">off</span>{/if}
    </button>
  {/each}
</div>
