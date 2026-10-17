<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import BoardCardTile from "./BoardCard.svelte";
  import type { BoardCard, BoardColumn } from "$lib/api/types";

  type Props = {
    column: BoardColumn;
    columns: BoardColumn[];
    onMove: (card: BoardCard, columnId: string) => void;
    onRelease: (card: BoardCard) => void;
    onEdit: (card: BoardCard) => void;
    onDelete: (card: BoardCard) => void;
  };
  let { column, columns, onMove, onRelease, onEdit, onDelete }: Props = $props();
</script>

<section class="flex w-72 shrink-0 flex-col gap-2" aria-label={column.title}>
  <header class="flex items-center justify-between gap-2 border-b px-1 pb-2">
    <div class="min-w-0">
      <h3 class="truncate text-body font-semibold">{column.title}</h3>
      {#if column.allowed_roles?.length}
        <p class="truncate text-caption text-muted-foreground">
          expects {column.allowed_roles.join(" or ")}
        </p>
      {/if}
    </div>
    <Badge variant={column.over_wip ? "destructive" : "secondary"} class="shrink-0">
      {column.card_count}{#if column.wip_limit}/{column.wip_limit}{/if}
    </Badge>
  </header>

  <div class="flex flex-col gap-2">
    {#each column.cards as card (card.id)}
      <BoardCardTile
        {card}
        {columns}
        onMove={(columnId) => onMove(card, columnId)}
        onRelease={() => onRelease(card)}
        onEdit={() => onEdit(card)}
        onDelete={() => onDelete(card)}
      />
    {:else}
      <p class="rounded-md border border-dashed px-3 py-6 text-center text-body-sm text-muted-foreground">
        Nothing here
      </p>
    {/each}
    {#if column.truncated}
      <p class="text-center text-caption text-muted-foreground">
        Showing the first {column.cards.length}; this lane holds more.
      </p>
    {/if}
  </div>
</section>
