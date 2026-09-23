<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Sheet from "$lib/components/ui/sheet";
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

  // A sheet rather than the window.prompt this used to be: a card now carries a
  // due date and an ordering, and neither survives being typed into a prompt.
  let editing = $state<BoardCard | null>(null);
  let editTitle = $state("");
  let editDetail = $state("");
  let editDueAt = $state("");
  let editDependsOn = $state("");
  let editError = $state<string | null>(null);

  function edit(card: BoardCard) {
    editing = card;
    editTitle = card.title;
    editDetail = card.detail ?? "";
    // `datetime-local` wants a local wall-clock string with no zone.
    editDueAt = card.due_at ? toLocalInput(card.due_at) : "";
    editDependsOn = (card.depends_on ?? []).map((n) => `#${n}`).join(", ");
    editError = null;
  }

  function toLocalInput(iso: string): string {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  }

  function parseDependsOn(text: string): number[] | null {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    const out: number[] = [];
    for (const part of parts) {
      const n = Number(part.replace(/^#/, ""));
      if (!Number.isInteger(n) || n <= 0) return null;
      if (!out.includes(n)) out.push(n);
    }
    return out;
  }

  const editMut = createMutation({
    mutationFn: (vars: {
      card: BoardCard;
      title: string;
      detail: string;
      due_at: string | null;
      depends_on: number[];
    }) =>
      updateCard(slug, vars.card.id, {
        title: vars.title,
        detail: vars.detail,
        due_at: vars.due_at,
        depends_on: vars.depends_on,
      }),
    onError: (err) => {
      // A cycle or an unknown card number is the operator's mistake to fix, so
      // it belongs in the sheet rather than in a toast that closes it.
      editError = err instanceof ApiError ? err.message : "Could not update the card";
    },
    onSuccess: () => {
      editing = null;
      toast.success("Card updated");
    },
    onSettled: refresh,
  });

  function submitEdit() {
    if (!editing) return;
    const title = editTitle.trim();
    if (!title) {
      editError = "Title cannot be empty";
      return;
    }
    const depends = parseDependsOn(editDependsOn);
    if (depends === null) {
      editError = "Depends on must be card numbers, like: #2, #3";
      return;
    }
    editError = null;
    $editMut.mutate({
      card: editing,
      title,
      detail: editDetail,
      due_at: editDueAt ? new Date(editDueAt).toISOString() : null,
      depends_on: depends,
    });
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

<Sheet.Root
  open={editing !== null}
  onOpenChange={(next) => {
    if (!next) editing = null;
  }}
>
  <Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-lg">
    <Sheet.Header>
      <Sheet.Title>Edit card #{editing?.number}</Sheet.Title>
      <Sheet.Description>
        Changes here do not move the card or touch its claim.
      </Sheet.Description>
    </Sheet.Header>
    <form
      class="mt-6 flex flex-col gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        submitEdit();
      }}
    >
      <div class="grid gap-1.5">
        <Label for="card-title">Title</Label>
        <Input id="card-title" bind:value={editTitle} />
      </div>
      <div class="grid gap-1.5">
        <Label for="card-detail">Detail</Label>
        <Textarea id="card-detail" bind:value={editDetail} rows={6} class="text-sm" />
      </div>
      <div class="grid gap-1.5">
        <Label for="card-due">Due</Label>
        <Input id="card-due" type="datetime-local" bind:value={editDueAt} />
      </div>
      <div class="grid gap-1.5">
        <Label for="card-deps">Depends on</Label>
        <Input id="card-deps" bind:value={editDependsOn} placeholder="#2, #3" />
        <p class="text-xs text-muted-foreground">
          Card numbers this one waits on. Leave empty for none.
        </p>
      </div>
      {#if editError}
        <Alert.Root variant="destructive">
          <Alert.Description>{editError}</Alert.Description>
        </Alert.Root>
      {/if}
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onclick={() => (editing = null)}>Cancel</Button>
        <Button type="submit" disabled={$editMut.isPending}>
          {$editMut.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  </Sheet.Content>
</Sheet.Root>
