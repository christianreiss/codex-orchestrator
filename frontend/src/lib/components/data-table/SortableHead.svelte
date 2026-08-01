<script lang="ts">
  /** A `Table.Head` whose label is a sort toggle button — the header pattern lifted from UsersTable. */
  import * as Table from "$lib/components/ui/table";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";

  type Props = {
    label: string;
    active: boolean;
    dir: "asc" | "desc";
    onclick: () => void;
    class?: string;
  };
  let { label, active, dir, onclick, class: className }: Props = $props();
  const ariaSort = $derived(active ? (dir === "asc" ? "ascending" : "descending") : "none");
</script>

<Table.Head class={className} aria-sort={ariaSort}>
  <button
    type="button"
    class="-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
    {onclick}
  >
    {label}
    {#if active}
      {#if dir === "asc"}
        <ArrowUp class="h-3 w-3" />
      {:else}
        <ArrowDown class="h-3 w-3" />
      {/if}
    {:else}
      <ChevronsUpDown class="h-3 w-3 opacity-50" />
    {/if}
  </button>
</Table.Head>
