<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import { Section, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import BoardColumnPane from "$lib/components/projects/board/BoardColumn.svelte";
  import CardEditSheet from "$lib/components/projects/board/CardEditSheet.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { createCard, deleteCard, fetchBoard, moveCard, projectKeys, releaseCard } from "$lib/api/projects";
  import { relativeTime } from "$lib/utils/format";
  import type { BoardCard } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  const boardQuery = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.board(slug), queryFn: () => fetchBoard(slug), enabled: slug.length > 0 })),
  );

  let formTitle = $state("");
  let editing = $state<BoardCard | null>(null);

  const columns = $derived($boardQuery.data?.columns ?? []);
  const reclaimed = $derived($boardQuery.data?.reclaimed_recently ?? []);

  function refresh() {
    void qc.invalidateQueries({ queryKey: projectKeys.board(slug) });
    void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
  }
  const failed = (err: unknown, fallback: string) => toast.error(err instanceof ApiError ? err.message : fallback);

  const createMut = createMutation({
    mutationFn: () => createCard(slug, { title: formTitle.trim() }),
    onError: (err) => failed(err, "Could not create the card"),
    onSuccess: () => { toast.success("Card created"); formTitle = ""; },
    onSettled: refresh,
  });
  const moveMut = createMutation({
    mutationFn: (vars: { card: BoardCard; columnId: string }) => moveCard(slug, vars.card.id, vars.columnId),
    onError: (err) => failed(err, "Could not move the card"),
    // A move never fails, so the interesting outcome is what it warned about: the console's half of "advisory, not enforcing".
    onSuccess: (result) => { for (const advisory of result.advisories ?? []) toast.warning(advisory.message); },
    onSettled: refresh,
  });
  const releaseMut = createMutation({
    mutationFn: (card: BoardCard) => releaseCard(slug, card.id),
    onError: (err) => failed(err, "Could not release the claim"),
    onSuccess: () => toast.success("Claim released"),
    onSettled: refresh,
  });
  const deleteMut = createMutation({
    mutationFn: (card: BoardCard) => deleteCard(slug, card.id),
    onError: (err) => failed(err, "Could not archive the card"),
    onSuccess: () => toast.success("Card archived"),
    onSettled: refresh,
  });
</script>

<div class="flex flex-col gap-4">
  {#if $boardQuery.isPending}
    <div class="flex gap-4">{#each [0, 1, 2, 3] as index (index)}<Skeleton class="h-64 w-72 shrink-0" />{/each}</div>
  {:else if $boardQuery.isError}
    <StateBlock state="error" message={$boardQuery.error instanceof ApiError ? $boardQuery.error.message : "Could not load the board"} onRetry={() => void $boardQuery.refetch()} />
  {:else}
    <!-- The lanes scroll inside this container; the page itself never scrolls sideways, however many columns are added. -->
    <div class="flex gap-4 overflow-x-auto pb-2">
      {#each columns as column (column.id)}
        <BoardColumnPane
          {column}
          {columns}
          onMove={(card, columnId) => $moveMut.mutate({ card, columnId })}
          onRelease={(card) => $releaseMut.mutate(card)}
          onEdit={(card) => (editing = card)}
          onDelete={(card) => $deleteMut.mutate(card)}
        />
      {/each}
    </div>

    <form class="flex flex-wrap items-center gap-2" onsubmit={(event) => { event.preventDefault(); if (formTitle.trim()) $createMut.mutate(); }}>
      <Input bind:value={formTitle} placeholder="New card title" class="max-w-sm" aria-label="New card title" />
      <Button type="submit" disabled={!formTitle.trim() || $createMut.isPending}><Plus class="h-4 w-4" /> Add card</Button>
    </form>

    {#if reclaimed.length > 0}
      <Section title="Recently reclaimed" description="Claims the board took back because the agent holding them stopped without releasing.">
        <ul class="space-y-1 text-body-sm">
          {#each reclaimed as card (card.id)}
            <li>
              <span class="font-mono">#{card.number}</span>
              {card.title} — {card.reason}
              {#if card.released_at}<span class="text-muted-foreground"> ({relativeTime(card.released_at)})</span>{/if}
            </li>
          {/each}
        </ul>
      </Section>
    {/if}
  {/if}
</div>

<CardEditSheet {slug} card={editing} onClose={() => (editing = null)} />
