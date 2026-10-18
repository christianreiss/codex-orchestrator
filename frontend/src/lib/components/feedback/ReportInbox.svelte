<script lang="ts">
  /** The report list: one compact button per report, with loading, error and empty states. */
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { StateBlock } from "$lib/components/page";
  import { cn } from "$lib/utils/cn";
  import type { ReportRow } from "./report-model";

  type Props = {
    items: ReportRow[] | undefined;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    selectedId: string;
    onSelect: (id: string) => void;
    /** True when a filter is active, so an empty list reads as "no matches". */
    filtered?: boolean;
    onClearFilters?: () => void;
    emptyTitle?: string;
    emptyDescription?: string;
    footer?: Snippet;
  };
  let { items, loading = false, error = null, onRetry, selectedId, onSelect, filtered = false, onClearFilters, emptyTitle = "No reports yet", emptyDescription, footer }: Props = $props();
</script>

<section aria-label="Report inbox" class="min-w-0" aria-busy={loading}>
  {#if error}<StateBlock state="error" message={error} {onRetry} />{/if}
  {#if loading && !items?.length}
    <StateBlock state="loading" />
  {:else if (!items || items.length === 0) && !error}
    <StateBlock
      state="empty"
      message={filtered ? "No reports match these filters." : emptyTitle}
      description={filtered ? "Try a different search or clear the filters." : emptyDescription}
    />
    {#if filtered && onClearFilters}<Button variant="outline" onclick={onClearFilters}>Clear filters</Button>{/if}
  {:else if items?.length}
    <ul class="divide-y rounded-md border">
      {#each items as row (row.id)}
        <li>
          <button
            type="button"
            class={cn("block w-full px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selectedId === row.id && "bg-muted")}
            aria-pressed={selectedId === row.id}
            onclick={() => onSelect(row.id)}
          >
            <span class="flex flex-wrap items-start gap-2">
              <span class="min-w-0 flex-1 break-words text-body font-medium">{row.title}</span>
              <span class="flex max-w-full flex-wrap gap-1 sm:justify-end">
                {#each row.badges as badge (badge.label)}<Badge variant={badge.variant ?? "outline"}>{badge.label}</Badge>{/each}
              </span>
            </span>
            <span class="mt-0.5 block text-caption text-muted-foreground">{row.meta}</span>
            {#if row.note}<span class="block break-words text-caption text-muted-foreground">{row.note}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {@render footer?.()}
</section>
