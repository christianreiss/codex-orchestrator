<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import Plus from "@lucide/svelte/icons/plus";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import X from "@lucide/svelte/icons/x";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Alert from "$lib/components/ui/alert";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import {
    createTodo,
    deleteTodo,
    fetchTodos,
    markTodoDone,
    markTodoUndone,
    projectKeys,
    updateTodo,
  } from "$lib/api/projects";
  import { relativeTime } from "$lib/utils/format";
  import type { ProjectTodo } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  const todosQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.todos(slug),
      queryFn: () => fetchTodos(slug),
      enabled: slug.length > 0,
    })),
  );

  let formTitle = $state("");
  let doneCollapsed = $state(false);

  const todos = $derived($todosQuery.data?.todos ?? []);
  const openTodos = $derived(todos.filter((t) => !t.done));
  const doneTodos = $derived(todos.filter((t) => t.done));

  function setListData(updater: (prev: ProjectTodo[]) => ProjectTodo[]) {
    qc.setQueryData<{ project: string; todos: ProjectTodo[] }>(projectKeys.todos(slug), (prev) => ({
      project: prev?.project ?? slug,
      todos: updater(prev?.todos ?? []),
    }));
  }

  const createMut = createMutation({
    mutationFn: () => createTodo(slug, { title: formTitle.trim() }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: projectKeys.todos(slug) });
      const previous = qc.getQueryData(projectKeys.todos(slug));
      const optimistic: ProjectTodo = {
        id: -Date.now(),
        title: formTitle.trim(),
        detail: "",
        done: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setListData((prev) => [optimistic, ...prev]);
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.todos(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not save todo");
    },
    onSuccess: () => {
      toast.success("Todo created");
      formTitle = "";
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.todos(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  let editingId = $state<number | null>(null);
  let editTitle = $state("");
  let editDetail = $state("");
  function startEdit(todo: ProjectTodo) {
    editingId = todo.id;
    editTitle = todo.title;
    editDetail = todo.detail ?? "";
  }
  function cancelEdit() {
    editingId = null;
    editTitle = "";
    editDetail = "";
  }

  const updateMut = createMutation({
    mutationFn: (vars: { id: number }) =>
      updateTodo(slug, vars.id, { title: editTitle.trim(), detail: editDetail.trim() }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: projectKeys.todos(slug) });
      const previous = qc.getQueryData(projectKeys.todos(slug));
      setListData((prev) =>
        prev.map((t) =>
          t.id === vars.id
            ? { ...t, title: editTitle.trim(), detail: editDetail.trim(), updated_at: new Date().toISOString() }
            : t,
        ),
      );
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.todos(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not update todo");
    },
    onSuccess: (_data, vars) => {
      toast.success("Todo updated");
      if (editingId === vars.id) cancelEdit();
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.todos(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  const toggleMut = createMutation({
    mutationFn: (vars: { id: number; done: boolean }) =>
      vars.done ? markTodoDone(slug, vars.id) : markTodoUndone(slug, vars.id),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: projectKeys.todos(slug) });
      const previous = qc.getQueryData(projectKeys.todos(slug));
      setListData((prev) => prev.map((t) => (t.id === vars.id ? { ...t, done: vars.done } : t)));
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.todos(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not update todo");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.todos(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  const deleteMut = createMutation({
    mutationFn: (id: number) => deleteTodo(slug, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: projectKeys.todos(slug) });
      const previous = qc.getQueryData(projectKeys.todos(slug));
      setListData((prev) => prev.filter((t) => t.id !== id));
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.todos(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not delete todo");
    },
    onSuccess: () => toast.success("Todo deleted"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.todos(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  const canSubmit = $derived(formTitle.trim().length > 0);
</script>

{#snippet todoRow(todo: ProjectTodo)}
  <Card.Root>
    {#if editingId === todo.id}
      <Card.Content class="flex flex-col gap-3 pt-6">
        <div class="grid gap-1.5">
          <Label for="edit-title-{todo.id}">Title</Label>
          <Input id="edit-title-{todo.id}" bind:value={editTitle} />
        </div>
        <div class="grid gap-1.5">
          <Label for="edit-detail-{todo.id}">Detail</Label>
          <Textarea id="edit-detail-{todo.id}" bind:value={editDetail} rows={4} />
        </div>
      </Card.Content>
      <Card.Footer class="flex justify-end gap-2 border-t pt-4">
        <Button variant="ghost" onclick={cancelEdit}>
          <X class="h-4 w-4" />
          Cancel
        </Button>
        <Button
          onclick={() => $updateMut.mutate({ id: todo.id })}
          disabled={$updateMut.isPending || !editTitle.trim()}
        >
          <Save class="h-4 w-4" />
          {$updateMut.isPending ? "Saving…" : "Save"}
        </Button>
      </Card.Footer>
    {:else}
      <Card.Header>
        <div class="flex items-start gap-3">
          <div class="pt-0.5">
            <Checkbox
              checked={todo.done}
              onCheckedChange={(next) =>
                $toggleMut.mutate({ id: todo.id, done: next === true })}
              aria-label={todo.done ? "Mark as not done" : "Mark as done"}
            />
          </div>
          <div class="min-w-0 flex-1">
            <Card.Title class="text-base {todo.done ? 'text-muted-foreground line-through' : ''}">
              {todo.title}
            </Card.Title>
            {#if todo.detail}
              <p
                class="mt-1 whitespace-pre-wrap text-sm {todo.done
                  ? 'text-muted-foreground/70'
                  : 'text-muted-foreground'}"
              >
                {todo.detail}
              </p>
            {/if}
            {#if todo.updated_at}
              <p class="mt-1 text-xs text-muted-foreground">
                Updated {relativeTime(todo.updated_at)}
              </p>
            {/if}
          </div>
          <div class="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Edit todo ${todo.title}`}
              onclick={() => startEdit(todo)}
            >
              <Pencil class="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Delete todo ${todo.title}`}
              onclick={() => $deleteMut.mutate(todo.id)}
              disabled={$deleteMut.isPending}
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card.Header>
    {/if}
  </Card.Root>
{/snippet}

<div class="flex flex-col gap-6">
  <form
    class="flex gap-2"
    onsubmit={(e) => {
      e.preventDefault();
      $createMut.mutate();
    }}
  >
    <Input
      aria-label="New todo title"
      bind:value={formTitle}
      placeholder="What needs doing? Add detail after creating."
      class="flex-1"
    />
    <Button type="submit" disabled={!canSubmit || $createMut.isPending}>
      <Plus class="h-4 w-4" />
      {$createMut.isPending ? "Adding…" : "Add"}
    </Button>
  </form>

  {#if $todosQuery.isLoading}
    <Skeleton class="h-24 w-full" />
  {:else if $todosQuery.isError}
    <Alert.Root variant="destructive">
      <Alert.Title>Could not load todos</Alert.Title>
      <Alert.Description>
        {$todosQuery.error instanceof ApiError ? $todosQuery.error.message : "Unknown error"}
      </Alert.Description>
    </Alert.Root>
  {:else}
    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-medium text-muted-foreground">
        Open · {openTodos.length}
      </h2>
      {#if openTodos.length === 0}
        <div class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          No open todos.
        </div>
      {:else}
        {#each openTodos as todo (todo.id)}
          {@render todoRow(todo)}
        {/each}
      {/if}
    </section>

    <section class="flex flex-col gap-3">
      <button
        type="button"
        class="flex items-center gap-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
        onclick={() => (doneCollapsed = !doneCollapsed)}
      >
        {#if doneCollapsed}
          <ChevronRight class="h-4 w-4" />
        {:else}
          <ChevronDown class="h-4 w-4" />
        {/if}
        Done · {doneTodos.length}
      </button>
      {#if !doneCollapsed}
        {#if doneTodos.length === 0}
          <div
            class="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground"
          >
            Nothing completed yet.
          </div>
        {:else}
          {#each doneTodos as todo (todo.id)}
            {@render todoRow(todo)}
          {/each}
        {/if}
      {/if}
    </section>
  {/if}
</div>
