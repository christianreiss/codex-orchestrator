<script lang="ts">
  /**
   * Advanced: how the fleet document is produced. Generated (modules and custom
   * instructions), Manual (hand-written Markdown) or Disabled. A change here
   * applies to the whole fleet at once and does not save a version.
   */
  import { untrack } from "svelte";
  import { cn } from "$lib/utils/cn";
  import { GENERATION_MODES, type RulesDocState } from "./rules-doc.svelte";

  let { doc }: { doc: RulesDocState } = $props();
  // Opens by itself only when the fleet is already off the default path; after that it is the operator's.
  let open = $state(untrack(() => doc.generationMode !== "managed"));
</script>

<details class="rounded-md border" bind:open>
  <summary class="cursor-pointer select-none px-3 py-2 text-body font-medium">Advanced</summary>
  <div class="space-y-2 border-t p-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-body font-medium">How the document is produced</p>
        <p class="text-body-sm text-muted-foreground">
          {doc.generationModeHint} Applies to the whole fleet as soon as you pick it, and no version is saved.
        </p>
      </div>
      <div class="inline-flex rounded-md border p-0.5" role="group" aria-label="AGENTS.md generation">
        {#each GENERATION_MODES as option (option.id)}
          <button
            type="button"
            aria-pressed={doc.generationMode === option.id}
            disabled={doc.modePending || doc.generationMode === option.id}
            onclick={() => doc.setGenerationMode(option.id)}
            class={cn(
              "h-8 rounded-md px-3 text-body-sm transition-colors disabled:cursor-default",
              doc.generationMode === option.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    <p class="text-body-sm text-muted-foreground">
      Switching to Manual starts from the document hosts are served today. Switching back restores the module selection exactly.
    </p>
  </div>
</details>
