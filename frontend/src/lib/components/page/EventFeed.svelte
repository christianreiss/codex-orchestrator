<script lang="ts">
  /** Filters on top, rows below, a pager at the bottom. For append-only histories. */
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button";

  type Props = {
    filters?: Snippet;
    children: Snippet;
    page: number;
    pageCount: number;
    onPage: (next: number) => void;
  };
  let { filters, children, page, pageCount, onPage }: Props = $props();
</script>

<div class="space-y-3">
  {@render filters?.()}
  {@render children()}
  {#if pageCount > 1}
    <div class="flex items-center justify-end gap-2 text-body-sm text-muted-foreground">
      <Button size="sm" variant="outline" disabled={page <= 1} onclick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pageCount}</span>
      <Button size="sm" variant="outline" disabled={page >= pageCount} onclick={() => onPage(page + 1)}>Next</Button>
    </div>
  {/if}
</div>
