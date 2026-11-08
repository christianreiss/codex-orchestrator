<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
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
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { createCard, deleteCard, fetchBoard, moveCard, projectKeys, releaseCard } from "$lib/api/projects";
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
    mutationFn: (title: string) => createCard(slug, { title }),
    onError: (err) => failed(err, "Could not create the card"),
    onSuccess: (_result, submitted) => { toast.success("Card created"); if (formTitle.trim() === submitted) formTitle = ""; },
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

  // The server archives rather than deletes (history keeps the row), but the
  // console has no restore and the card's dependency links are dropped, so it
  // names the card and asks first.
  let deleteTarget = $state<BoardCard | null>(null);
  let deleteOpen = $state(false);
  let deleteError = $state<string | null>(null);
  function askDelete(card: BoardCard) {
    deleteTarget = card;
    deleteError = null;
    deleteOpen = true;
  }
  async function confirmDelete() {
    if (!deleteTarget || $deleteMut.isPending) return;
    try {
      await $deleteMut.mutateAsync(deleteTarget);
      deleteOpen = false;
    } catch (err) {
      deleteError = err instanceof ApiError ? err.message : "Could not archive the card";
    }
  }
</script>

<div class="flex flex-col gap-4">
  {#if $boardQuery.isPending}
    <div class="flex gap-4 overflow-hidden" aria-label="Loading board">{#each [0, 1, 2, 3] as index (index)}<Skeleton class="h-64 w-72 shrink-0" />{/each}</div>
  {:else if $boardQuery.isError}
    <StateBlock state="error" cause={$boardQuery.error} message={$boardQuery.error instanceof ApiError ? $boardQuery.error.message : "Could not load the board"} onRetry={() => void $boardQuery.refetch()} />
  {:else}
    <!-- The lanes scroll inside this container; the page itself never scrolls sideways, however many columns are added. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="flex min-w-0 max-w-full gap-4 overflow-x-auto pb-2" role="region" aria-label="Project board columns" tabindex="0">
      {#each columns as column (column.id)}
        <BoardColumnPane
          {column}
          {columns}
          onMove={(card, columnId) => $moveMut.mutate({ card, columnId })}
          onRelease={(card) => $releaseMut.mutate(card)}
          onEdit={(card) => (editing = card)}
          onDelete={askDelete}
        />
      {/each}
    </div>

    <form class="flex flex-wrap items-center gap-2" onsubmit={(event) => { event.preventDefault(); if (formTitle.trim() && !$createMut.isPending) $createMut.mutate(formTitle.trim()); }}>
      <label for="new-card-title" class="w-full text-body font-medium">New card title</label>
      <Input id="new-card-title" bind:value={formTitle} placeholder="New card title" class="max-w-sm" aria-label="New card title" />
      <Button type="submit" disabled={!formTitle.trim() || $createMut.isPending}><Plus class="h-4 w-4" /> Add card</Button>
    </form>
    {#if $createMut.isError}<p role="alert" class="text-body-sm text-destructive">Could not create the card: {$createMut.error.message}</p>{/if}
    {#if $moveMut.isError}<p role="alert" class="text-body-sm text-destructive">Could not move the card: {$moveMut.error.message}</p>{/if}
    {#if $releaseMut.isError}<p role="alert" class="text-body-sm text-destructive">Could not release the claim: {$releaseMut.error.message}</p>{/if}

    {#if reclaimed.length > 0}
      <Section title="Recently reclaimed" description="Claims the board took back because the agent holding them stopped without releasing.">
        <ul class="space-y-1 text-body-sm">
          {#each reclaimed as card (card.id)}
            <li>
              <span class="font-mono">#{card.number}</span>
              {card.title} — {card.reason}
              {#if card.released_at}<span class="text-muted-foreground"> (<Timestamp value={card.released_at} />)</span>{/if}
            </li>
          {/each}
        </ul>
      </Section>
    {/if}
  {/if}
</div>

<CardEditSheet {slug} card={editing} onClose={() => (editing = null)} />

<ConfirmDialog
  bind:open={deleteOpen}
  title={deleteTarget ? `Archive card #${deleteTarget.number} “${deleteTarget.title}”?` : "Archive card?"}
  description="The card leaves the board for everyone, any claim on it is released and its dependency links are removed. Its history is kept, but the console cannot restore it."
  confirmLabel="Archive card"
  busyLabel="Archiving…"
  destructive
  busy={$deleteMut.isPending}
  error={deleteError}
  onConfirm={confirmDelete}
/>
