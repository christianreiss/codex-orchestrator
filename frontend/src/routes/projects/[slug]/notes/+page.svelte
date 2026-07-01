<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import X from "@lucide/svelte/icons/x";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Alert from "$lib/components/ui/alert";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import {
    createNote,
    deleteNote,
    fetchNotes,
    projectKeys,
    updateNote,
  } from "$lib/api/projects";
  import { relativeTime } from "$lib/utils/format";
  import type { ProjectNote } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  const notesQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.notes(slug),
      queryFn: () => fetchNotes(slug),
      enabled: slug.length > 0,
    })),
  );

  let formHeader = $state("");
  let formBody = $state("");

  function resetForm() {
    formHeader = "";
    formBody = "";
  }

  const createMut = createMutation({
    mutationFn: () => createNote(slug, { header: formHeader.trim(), body: formBody.trim() }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: projectKeys.notes(slug) });
      const previous = qc.getQueryData<{ notes: ProjectNote[] }>(projectKeys.notes(slug));
      const optimistic: ProjectNote = {
        id: -Date.now(),
        header: formHeader.trim(),
        body: formBody.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      qc.setQueryData<{ project: string; notes: ProjectNote[] }>(
        projectKeys.notes(slug),
        (prev) => ({
          project: prev?.project ?? slug,
          notes: [optimistic, ...(prev?.notes ?? [])],
        }),
      );
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.notes(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not save note");
    },
    onSuccess: () => {
      toast.success("Note saved");
      resetForm();
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.notes(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  // Inline-edit state
  let editingId = $state<number | null>(null);
  let editHeader = $state("");
  let editBody = $state("");

  function startEdit(note: ProjectNote) {
    editingId = note.id;
    editHeader = note.header;
    editBody = note.body;
  }
  function cancelEdit() {
    editingId = null;
    editHeader = "";
    editBody = "";
  }

  const updateMut = createMutation({
    mutationFn: (vars: { id: number }) =>
      updateNote(slug, vars.id, { header: editHeader.trim(), body: editBody.trim() }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: projectKeys.notes(slug) });
      const previous = qc.getQueryData<{ notes: ProjectNote[] }>(projectKeys.notes(slug));
      qc.setQueryData<{ project: string; notes: ProjectNote[] }>(
        projectKeys.notes(slug),
        (prev) => ({
          project: prev?.project ?? slug,
          notes: (prev?.notes ?? []).map((n) =>
            n.id === vars.id
              ? { ...n, header: editHeader.trim(), body: editBody.trim(), updated_at: new Date().toISOString() }
              : n,
          ),
        }),
      );
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.notes(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not update note");
    },
    onSuccess: (_data, vars) => {
      toast.success("Note updated");
      if (editingId === vars.id) cancelEdit();
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.notes(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  const deleteMut = createMutation({
    mutationFn: (id: number) => deleteNote(slug, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: projectKeys.notes(slug) });
      const previous = qc.getQueryData<{ notes: ProjectNote[] }>(projectKeys.notes(slug));
      qc.setQueryData<{ project: string; notes: ProjectNote[] }>(
        projectKeys.notes(slug),
        (prev) => ({
          project: prev?.project ?? slug,
          notes: (prev?.notes ?? []).filter((n) => n.id !== id),
        }),
      );
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.notes(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not delete note");
    },
    onSuccess: () => toast.success("Note deleted"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.notes(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  const notes = $derived($notesQuery.data?.notes ?? []);
  const canSubmit = $derived(formHeader.trim().length > 0 && formBody.trim().length > 0);
</script>

<div class="flex flex-col gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>New note</Card.Title>
      <Card.Description>Header and body are both required.</Card.Description>
    </Card.Header>
    <Card.Content class="flex flex-col gap-3">
      <div class="grid gap-1.5">
        <Label for="note-header">Header</Label>
        <Input id="note-header" bind:value={formHeader} placeholder="Short note title" />
      </div>
      <div class="grid gap-1.5">
        <Label for="note-body">Body</Label>
        <Textarea id="note-body" bind:value={formBody} rows={6} placeholder="Note contents…" />
      </div>
    </Card.Content>
    <Card.Footer class="flex flex-wrap justify-end gap-2 border-t pt-4">
      <Button variant="ghost" onclick={resetForm} disabled={!formHeader && !formBody}>
        <RotateCcw class="h-4 w-4" />
        Reset
      </Button>
      <Button onclick={() => $createMut.mutate()} disabled={!canSubmit || $createMut.isPending}>
        <Save class="h-4 w-4" />
        {$createMut.isPending ? "Saving…" : "Save"}
      </Button>
    </Card.Footer>
  </Card.Root>

  <section class="flex flex-col gap-3">
    <h2 class="text-sm font-medium text-muted-foreground">
      {notes.length} {notes.length === 1 ? "note" : "notes"}
    </h2>

    {#if $notesQuery.isLoading}
      <Skeleton class="h-24 w-full" />
    {:else if $notesQuery.isError}
      <Alert.Root variant="destructive">
        <Alert.Title>Could not load notes</Alert.Title>
        <Alert.Description>
          {$notesQuery.error instanceof ApiError ? $notesQuery.error.message : "Unknown error"}
        </Alert.Description>
      </Alert.Root>
    {:else if notes.length === 0}
      <div class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        No notes yet.
      </div>
    {:else}
      {#each notes as note (note.id)}
        <Card.Root>
          {#if editingId === note.id}
            <Card.Content class="flex flex-col gap-3 pt-6">
              <div class="grid gap-1.5">
                <Label for="edit-header-{note.id}">Header</Label>
                <Input id="edit-header-{note.id}" bind:value={editHeader} />
              </div>
              <div class="grid gap-1.5">
                <Label for="edit-body-{note.id}">Body</Label>
                <Textarea id="edit-body-{note.id}" bind:value={editBody} rows={5} />
              </div>
            </Card.Content>
            <Card.Footer class="flex justify-end gap-2 border-t pt-4">
              <Button variant="ghost" onclick={cancelEdit}>
                <X class="h-4 w-4" />
                Cancel
              </Button>
              <Button
                onclick={() => $updateMut.mutate({ id: note.id })}
                disabled={$updateMut.isPending || !editHeader.trim() || !editBody.trim()}
              >
                <Save class="h-4 w-4" />
                {$updateMut.isPending ? "Saving…" : "Save"}
              </Button>
            </Card.Footer>
          {:else}
            <Card.Header>
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="min-w-0">
                  <Card.Title class="truncate text-base">{note.header}</Card.Title>
                  {#if note.updated_at}
                    <Card.Description>Updated {relativeTime(note.updated_at)}</Card.Description>
                  {/if}
                </div>
                <div class="flex gap-1">
                  <Button variant="ghost" size="sm" onclick={() => startEdit(note)}>
                    <Pencil class="h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => $deleteMut.mutate(note.id)}
                    disabled={$deleteMut.isPending}
                  >
                    <Trash2 class="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            </Card.Header>
            <Card.Content>
              <p class="whitespace-pre-wrap text-sm text-foreground/90">{note.body}</p>
            </Card.Content>
          {/if}
        </Card.Root>
      {/each}
    {/if}
  </section>
</div>
