<script lang="ts">
  /**
   * One expandable table row (cells) plus its detail row. Clicking the row or
   * pressing Enter/Space on its chevron toggles the detail. Rendered inside
   * a `DataTable` row snippet, so it emits `<tr>`s only.
   */
  import type { Snippet } from "svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import * as Table from "$lib/components/ui/table";

  type Props = {
    expanded: boolean;
    onToggle: () => void;
    /** Accessible name of the toggle, e.g. "#7 todo.updated". */
    label: string;
    /** Number of data columns after the chevron, for the detail row span. */
    columns: number;
    cells: Snippet;
    detail: Snippet;
  };
  let { expanded, onToggle, label, columns, cells, detail }: Props = $props();
</script>

<!-- The chevron button is the keyboard path; the row click is the pointer convenience. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<Table.Row class="cursor-pointer" data-state={expanded ? "selected" : undefined} onclick={onToggle}>
  <Table.Cell class="w-8 pr-0">
    <button
      type="button"
      class="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-expanded={expanded}
      aria-label={label}
    >
      {#if expanded}<ChevronDown class="h-4 w-4" />{:else}<ChevronRight class="h-4 w-4" />{/if}
    </button>
  </Table.Cell>
  {@render cells()}
</Table.Row>
{#if expanded}
  <Table.Row class="bg-muted/30 hover:bg-muted/30">
    <Table.Cell colspan={columns + 1} class="px-4 py-3">{@render detail()}</Table.Cell>
  </Table.Row>
{/if}
