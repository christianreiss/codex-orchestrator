<script lang="ts">
  import type { ProjectCounts } from "$lib/api/types";

  type Props = { counts: ProjectCounts | undefined | null };
  let { counts }: Props = $props();

  const items = $derived([
    { label: "Notes", value: counts?.notes ?? 0 },
    { label: "Open todos", value: counts?.open_todos ?? 0 },
    { label: "Bugs", value: 0, isBug: true },
    { label: "Files", value: counts?.files ?? 0 },
  ]);
</script>

<div
  class="grid grid-cols-2 gap-3 rounded-lg border bg-card p-3 sm:grid-cols-4"
  aria-label="Project counts"
>
  {#each items as item (item.label)}
    <div class="flex flex-col">
      <span class="text-xs uppercase tracking-wide text-muted-foreground">{item.label}</span>
      <span class="text-xl font-semibold tabular-nums">{item.value}</span>
    </div>
  {/each}
</div>
