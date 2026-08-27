<script lang="ts">
  import { cn } from "$lib/utils/cn";
  import { relativeTime } from "$lib/utils/format";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";
  import type { BoardCard, BoardColumn } from "$lib/api/types";

  type Props = {
    card: BoardCard;
    columns: BoardColumn[];
    onMove: (columnId: string) => void;
    onRelease: () => void;
    onEdit: () => void;
    onDelete: () => void;
  };
  let { card, columns, onMove, onRelease, onEdit, onDelete }: Props = $props();

  const held = $derived(card.claim?.held === true);
  const holder = $derived(
    card.claim?.held
      ? [card.claim.username, card.claim.host].filter(Boolean).join(" on ")
      : null,
  );
  const targets = $derived(columns.filter((column) => column.id !== card.column?.id));
</script>

<article
  class={cn(
    "rounded-md border bg-card p-3 text-sm shadow-sm transition-colors",
    held ? "border-primary/50" : "border-border/60",
  )}
>
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <span class="font-mono text-xs text-muted-foreground">#{card.number}</span>
      <h4 class="font-medium leading-snug break-words">{card.title}</h4>
    </div>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="icon" class="size-7 shrink-0" aria-label="Card actions">
            <MoreHorizontal class="size-4" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Label>Move to</DropdownMenu.Label>
        {#each targets as target (target.id)}
          <DropdownMenu.Item onSelect={() => onMove(target.id)}>{target.title}</DropdownMenu.Item>
        {/each}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={onEdit}>Edit</DropdownMenu.Item>
        {#if held}
          <DropdownMenu.Item onSelect={onRelease}>Force release</DropdownMenu.Item>
        {/if}
        <DropdownMenu.Item onSelect={onDelete}>Archive</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  {#if card.blocked_reason}
    <p class="mt-2 text-xs text-destructive">{card.blocked_reason}</p>
  {/if}

  <div class="mt-2 flex flex-wrap items-center gap-1">
    {#each card.labels as label (label)}
      <Badge variant="outline" class="text-[10px]">{label}</Badge>
    {/each}
    {#if held}
      <!-- The expiry is the useful part, not the fact of a claim: it is what
           tells an operator whether to wait or to force a release. -->
      <Badge variant="secondary" class="text-[10px]">
        {card.claim?.role ?? "held"} · {holder}
        {#if card.claim?.expires_at}
          · expires {relativeTime(card.claim.expires_at)}
        {/if}
      </Badge>
    {:else if card.claim?.release_reason}
      <span class="text-[10px] text-muted-foreground">{card.claim.release_reason}</span>
    {/if}
  </div>
</article>
