<script lang="ts">
  /** Scope chips on one line; tag chips collapsed until asked for (open while any tag is selected). */
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils/cn";
  import type { MemoriesState } from "./memories-state.svelte";

  let { state }: { state: MemoriesState } = $props();

  const visibleTags = $derived(state.facets.tags.slice(0, 18));
  const extraSelected = $derived(state.selectedTags.filter((selected) => !state.facets.tags.some((tag) => tag.value === selected)));
  const tagChip = "rounded-md border px-2 py-0.5 text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<div class="space-y-2">
  <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Memory scope">
    <span class="text-caption text-muted-foreground">Scope</span>
    {#each ["shared", "project", "host"] as const as scope (scope)}
      <Button size="sm" variant={state.scopes.includes(scope) ? "secondary" : "outline"} class="capitalize" aria-pressed={state.scopes.includes(scope)} onclick={() => state.toggleScope(scope)}>
        {scope}
        <span class="ml-1 text-caption opacity-70">{state.totals[scope]}</span>
      </Button>
    {/each}
  </div>

  {#if state.facets.tags.length || state.selectedTags.length}
    <details open={state.selectedTags.length > 0}>
      <summary class="cursor-pointer select-none text-body-sm text-muted-foreground">
        Tags{state.selectedTags.length ? ` (${state.selectedTags.length} selected)` : ""}
      </summary>
      <div class="mt-2 flex flex-wrap gap-1.5">
        {#each visibleTags as tag (tag.value)}
          <button
            type="button"
            class={cn(tagChip, state.selectedTags.includes(tag.value) ? "border-primary/35 bg-primary/10 text-primary" : "bg-background text-muted-foreground hover:text-foreground")}
            aria-pressed={state.selectedTags.includes(tag.value)}
            onclick={() => state.toggleTag(tag.value)}
          >
            {tag.value} <span class="opacity-60">{tag.count}</span>
          </button>
        {/each}
        {#each extraSelected as tag (tag)}
          <button type="button" class={cn(tagChip, "border-primary/35 bg-primary/10 text-primary")} aria-pressed="true" onclick={() => state.toggleTag(tag)}>{tag} ×</button>
        {/each}
      </div>
    </details>
  {/if}

  {#if state.truncatedFacetNames}
    <p class="text-caption text-muted-foreground">
      Capped filter choices ({state.truncatedFacetNames}) show the top 200 values; the current page remains complete.
    </p>
  {/if}
</div>
