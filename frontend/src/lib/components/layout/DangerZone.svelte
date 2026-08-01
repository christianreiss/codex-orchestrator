<script lang="ts">
  /**
   * Isolated container for irreversible actions — the destructive-isolation
   * rule: destructive controls never share a row or section with benign ones.
   */
  import type { Snippet } from "svelte";

  type Props = {
    title?: string;
    description?: string;
    children: Snippet;
  };
  let { title = "Danger zone", description, children }: Props = $props();
</script>

<section class="border-y border-destructive/30 py-5" aria-labelledby="danger-zone-title">
  <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <h2 id="danger-zone-title" class="text-sm font-semibold text-destructive">{title}</h2>
      {#if description}
        <p class="mt-1 text-sm text-muted-foreground">{description}</p>
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {@render children()}
    </div>
  </div>
</section>
