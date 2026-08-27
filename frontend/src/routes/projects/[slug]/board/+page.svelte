<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Alert from "$lib/components/ui/alert";
  import BoardColumnPane from "$lib/components/projects/board/BoardColumn.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import {
    createCard,
    deleteCard,
    fetchBoard,
    moveCard,
    projectKeys,
    releaseCard,
    updateCard,
  } from "$lib/api/projects";
  import { relativeTime } from "$lib/utils/format";
  import type { BoardCard } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  const boardQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.board(slug),
      queryFn: () => fetchBoard(slug),
      enabled: slug.length > 0,
    })),
  );

  let formTitle = $state("");

  const columns = $derived($boardQuery.data?.columns ?? []);
  const reclaimed = $derived($boardQuery.data?.reclaimed_recently ?? []);

  function refresh() {
    void qc.invalidateQueries({ queryKey: projectKeys.board(slug) });
    void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
  }

  function failed(err: unknown, fallback: string) {
    toast.error(err instanceof ApiError ? err.message : fallback);
  }

  const createMut = createMutation({
    mutationFn: () => createCard(slug, { title: formTitle.trim() }),
    onError: (err) => failed(err, "Could not create the card"),
    onSuccess: () => {
      toast.success("Card created");
      formTitle = "";
    },
    onSettled: refresh,
  });

  const moveMut = createMutation({
    mutationFn: (vars: { card: BoardCard; columnId: string }) =>
      moveCard(slug, vars.card.id, vars.columnId),
    onError: (err) => failed(err, "Could not move the card"),
    onSuccess: (result) => {
      // A move never fails, so the interesting outcome is what it warned about.
      // Surfacing the advisory here is the console's half of "advisory, not
      // enforcing": the operator did the thing and is told what it cost.
      for (const advisory of result.advisories ?? []) toast.warning(advisory.message);
    },
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

  const editMut = createMutation({
    mutationFn: (vars: { card: BoardCard; title: string }) =>
      updateCard(slug, vars.card.id, { title: vars.title }),
    onError: (err) => failed(err, "Could not update the card"),
    onSettled: refresh,
  });

  function edit(card: BoardCard) {
    const next = window.prompt("Card title", card.title);
    if (next === null) return;
    const title = next.trim();
    if (!title || title === card.title) return;
    $editMut.mutate({ card, title });
  }
</script>

<div class="flex flex-col gap-4">
  <form
    class="flex flex-wrap items-center gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      if (formTitle.trim()) $createMut.mutate();
    }}
  >
    <Input
      bind:value={formTitle}
      placeholder="New card title"
      class="max-w-sm"
      aria-label="New card title"
    />
    <Button type="submit" disabled={!formTitle.trim() || $createMut.isPending}>
      <Plus class="mr-1 size-4" /> Add card
    </Button>
  </form>

  {#if $boardQuery.isPending}
    <div class="flex gap-4">
      {#each [0, 1, 2, 3] as index (index)}
        <Skeleton class="h-64 w-72 shrink-0" />
      {/each}
    </div>
  {:else if $boardQuery.isError}
    <Alert.Root variant="destructive">
      <Alert.Title>Could not load the board</Alert.Title>
      <Alert.Description>
        {$boardQuery.error instanceof ApiError ? $boardQuery.error.message : "Unexpected error"}
      </Alert.Description>
    </Alert.Root>
  {:else}
    <!-- The lanes scroll inside this container; the page itself never scrolls
         sideways, however many columns an operator adds. -->
    <div class="flex gap-4 overflow-x-auto pb-2">
      {#each columns as column (column.id)}
        <BoardColumnPane
          {column}
          {columns}
          onMove={(card, columnId) => $moveMut.mutate({ card, columnId })}
          onRelease={(card) => $releaseMut.mutate(card)}
          onEdit={edit}
          onDelete={(card) => $deleteMut.mutate(card)}
        />
      {/each}
    </div>

    {#if reclaimed.length > 0}
      <section class="rounded-md border border-border/60 bg-card/70 p-3">
        <h3 class="text-sm font-semibold">Recently reclaimed</h3>
        <p class="text-xs text-muted-foreground">
          Claims the board took back because the agent holding them stopped without releasing.
        </p>
        <ul class="mt-2 space-y-1 text-xs">
          {#each reclaimed as card (card.id)}
            <li>
              <span class="font-mono">#{card.number}</span>
              {card.title} — {card.reason}
              {#if card.released_at}<span class="text-muted-foreground"> ({relativeTime(card.released_at)})</span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>
