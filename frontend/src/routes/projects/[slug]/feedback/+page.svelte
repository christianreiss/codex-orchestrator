<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Save from "@lucide/svelte/icons/save";
  import Plus from "@lucide/svelte/icons/plus";
  import * as Card from "$lib/components/ui/card";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Badge, type BadgeVariant } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Alert from "$lib/components/ui/alert";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import {
    createFeedback,
    fetchFeedback,
    projectKeys,
  } from "$lib/api/projects";
  import { relativeTime } from "$lib/utils/format";
  import type { ProjectFeedback, ProjectFeedbackType } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  const feedbackQuery = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.feedback(slug),
      queryFn: () => fetchFeedback(slug),
      enabled: slug.length > 0,
    })),
  );

  let type = $state<ProjectFeedbackType>("feature");
  let title = $state("");
  let body = $state("");
  let createOpen = $state(false);

  function resetForm() {
    type = "feature";
    title = "";
    body = "";
  }

  const TYPE_LABEL: Record<ProjectFeedbackType, string> = {
    feature: "Feature",
    bug: "Bug",
    note: "Note",
    issue: "Issue",
    test: "Test",
  };

  const TYPE_BADGE: Record<ProjectFeedbackType, BadgeVariant> = {
    feature: "default",
    bug: "destructive",
    note: "secondary",
    issue: "destructive",
    test: "outline",
  };

  const createMut = createMutation({
    mutationFn: () => createFeedback(slug, { type, title: title.trim(), body: body.trim() }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: projectKeys.feedback(slug) });
      const previous = qc.getQueryData(projectKeys.feedback(slug));
      const optimistic: ProjectFeedback = {
        id: -Date.now(),
        type,
        title: title.trim(),
        body: body.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      qc.setQueryData<{ project: string | null; feedback: ProjectFeedback[] }>(
        projectKeys.feedback(slug),
        (prev) => ({
          project: prev?.project ?? slug,
          feedback: [optimistic, ...(prev?.feedback ?? [])],
        }),
      );
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.feedback(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not save feedback");
    },
    onSuccess: () => {
      toast.success("Feedback recorded");
      resetForm();
      createOpen = false;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.feedback(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });

  const items = $derived(
    [...($feedbackQuery.data?.feedback ?? [])].sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b.created_at ? Date.parse(b.created_at) : 0;
      return tb - ta;
    }),
  );
  const canSubmit = $derived(title.trim().length > 0 && body.trim().length > 0);
</script>

<div class="flex flex-col gap-6">
  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-sm font-medium text-muted-foreground">
        {items.length} {items.length === 1 ? "entry" : "entries"} · read-only log
      </h2>
      <Button size="sm" onclick={() => (createOpen = true)}>
        <Plus class="h-4 w-4" />
        New feedback
      </Button>
    </div>

    {#if $feedbackQuery.isLoading}
      <Skeleton class="h-20 w-full" />
    {:else if $feedbackQuery.isError}
      <Alert.Root variant="destructive">
        <Alert.Title>Could not load feedback</Alert.Title>
        <Alert.Description>
          {$feedbackQuery.error instanceof ApiError
            ? $feedbackQuery.error.message
            : "Unknown error"}
        </Alert.Description>
      </Alert.Root>
    {:else if items.length === 0}
      <div class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        No feedback yet.
      </div>
    {:else}
      {#each items as entry (entry.id)}
        <Card.Root>
          <Card.Header>
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <Badge variant={TYPE_BADGE[entry.type] ?? "default"}>
                    {TYPE_LABEL[entry.type] ?? entry.type}
                  </Badge>
                  <Card.Title class="truncate text-base">{entry.title}</Card.Title>
                </div>
                <Card.Description>{relativeTime(entry.created_at)}</Card.Description>
              </div>
            </div>
          </Card.Header>
          <Card.Content>
            <p class="whitespace-pre-wrap text-sm text-foreground/90">{entry.body}</p>
          </Card.Content>
        </Card.Root>
      {/each}
    {/if}
  </section>
</div>

<Sheet.Root
  bind:open={createOpen}
  onOpenChange={(next) => {
    createOpen = next;
    if (!next) resetForm();
  }}
>
  <Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-lg">
    <Sheet.Header>
      <Sheet.Title>New feedback</Sheet.Title>
      <Sheet.Description>Track a feature request, issue, test report, or note.</Sheet.Description>
    </Sheet.Header>
    <form
      class="mt-6 flex flex-col gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        $createMut.mutate();
      }}
    >
      <div class="grid gap-3 sm:grid-cols-[160px_1fr]">
        <div class="grid gap-1.5">
          <Label for="fb-type">Type</Label>
          <select
            id="fb-type"
            bind:value={type}
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="feature">Feature</option>
            <option value="bug">Bug</option>
            <option value="issue">Issue</option>
            <option value="test">Test</option>
            <option value="note">Note</option>
          </select>
        </div>
        <div class="grid gap-1.5">
          <Label for="fb-title">Title</Label>
          <Input id="fb-title" bind:value={title} placeholder="Short summary" />
        </div>
      </div>
      <div class="grid gap-1.5">
        <Label for="fb-body">Body</Label>
        <Textarea id="fb-body" bind:value={body} rows={6} placeholder="Describe the feedback…" />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onclick={() => (createOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={!canSubmit || $createMut.isPending}>
          <Save class="h-4 w-4" />
          {$createMut.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  </Sheet.Content>
</Sheet.Root>
