<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import { Badge } from "$lib/components/ui/badge";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Alert from "$lib/components/ui/alert";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import ProjectTabsNav from "$lib/components/projects/ProjectTabsNav.svelte";
  import ConfirmDialog from "$lib/components/projects/ConfirmDialog.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import {
    archiveProject,
    deleteProject,
    fetchProjectSummary,
    projectKeys,
    unarchiveProject,
  } from "$lib/api/projects";

  let { children } = $props();

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");
  const currentPath = $derived(page.url.pathname);

  // The lean summary, not `fetchProject`: this query runs on every tab, and the
  // detail response carries every file body — 597 KB on one live project, paid
  // again for the Activity tab and again for Feedback.
  const detail = createQuery(
    reactiveOptions(() => ({
      queryKey: projectKeys.summary(slug),
      queryFn: () => fetchProjectSummary(slug),
      enabled: slug.length > 0,
    })),
  );

  let confirmOpen = $state(false);
  const deleteMutation = createMutation({
    mutationFn: () => deleteProject(slug),
    onSuccess: () => {
      toast.success(`Deleted project ${slug}`);
      void qc.invalidateQueries({ queryKey: projectKeys.list });
      void qc.removeQueries({ queryKey: projectKeys.detail(slug) });
      void goto(`${base}/projects`);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Could not delete project");
    },
  });

  const archivedAt = $derived($detail.data?.project?.archived_at ?? null);

  // Archiving is reversible and keeps the project readable, so unlike Delete it
  // needs no confirmation dialog.
  const archiveMutation = createMutation({
    mutationFn: (archive: boolean) => (archive ? archiveProject(slug) : unarchiveProject(slug)),
    onSuccess: (_data, archive) => {
      toast.success(archive ? `Archived ${slug}` : `Reopened ${slug}`);
      void qc.invalidateQueries({ queryKey: projectKeys.list });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Could not change archive state");
    },
  });

  const title = $derived(
    $detail.data?.project?.about &&
      typeof ($detail.data.project.about as Record<string, unknown>).title === "string"
      ? (($detail.data.project.about as Record<string, unknown>).title as string)
      : slug,
  );
  const counts = $derived($detail.data?.project?.counts);
  // Counted server-side now. It used to be `feedback.filter(f => f.type === "bug")`
  // over the full feedback array, which is part of why the whole tree had to be
  // fetched to render a number.
  const bugCount = $derived($detail.data?.project?.feedback_by_type?.bug ?? 0);
</script>

<PageHeader title={title} subtitle={slug !== title ? slug : undefined}>
  {#snippet actions()}
    {#if archivedAt}
      <Badge variant="outline">Archived</Badge>
    {/if}
    <Button variant="outline" href="{base}/projects">
      <ArrowLeft class="h-4 w-4" />
      Back
    </Button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-card px-3 text-sm font-medium transition-colors hover:bg-accent"
        disabled={!$detail.data}
      >
        <Ellipsis class="h-4 w-4" /> More
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-56">
        <DropdownMenu.Item
          onclick={() => $archiveMutation.mutate(!archivedAt)}
          disabled={$archiveMutation.isPending}
        >
          {#if archivedAt}
            <ArchiveRestore class="h-4 w-4" /> Reopen project
          {:else}
            <Archive class="h-4 w-4" /> Archive project
          {/if}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          onclick={() => (confirmOpen = true)}
          class="text-destructive focus:bg-destructive-muted focus:text-destructive"
        >
          <Trash2 class="h-4 w-4" /> Delete project
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}
</PageHeader>

{#if $detail.isLoading}
  <Skeleton class="mb-4 h-20 w-full" />
{:else if $detail.isError}
  <Alert.Root variant="destructive" class="mb-4">
    <Alert.Title>Could not load project</Alert.Title>
    <Alert.Description>
      {$detail.error instanceof ApiError ? $detail.error.message : "Unknown error"}
    </Alert.Description>
  </Alert.Root>
{:else}
  <div class="mb-4 grid grid-cols-2 border-y border-border sm:grid-cols-4">
    <div class="flex flex-col border-b border-border px-3 py-2.5 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <span class="text-xs uppercase tracking-wide text-muted-foreground">Notes</span>
      <span class="text-xl font-semibold tabular-nums">{counts?.notes ?? 0}</span>
    </div>
    <div class="flex flex-col border-b border-border px-3 py-2.5 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <span class="text-xs uppercase tracking-wide text-muted-foreground">Open todos</span>
      <span class="text-xl font-semibold tabular-nums">{counts?.open_todos ?? 0}</span>
    </div>
    <div class="flex flex-col px-3 py-2.5 sm:border-r sm:last:border-r-0">
      <span class="text-xs uppercase tracking-wide text-muted-foreground">Bugs</span>
      <span class="text-xl font-semibold tabular-nums">{bugCount}</span>
    </div>
    <div class="flex flex-col px-3 py-2.5">
      <span class="text-xs uppercase tracking-wide text-muted-foreground">Files</span>
      <span class="text-xl font-semibold tabular-nums">{counts?.files ?? 0}</span>
    </div>
  </div>
{/if}

<ProjectTabsNav {slug} {currentPath} />

<div class="mt-6">
  {@render children?.()}
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Delete project?"
  description="This permanently removes {slug} and all of its notes, todos, files, and feedback."
  confirmLabel="Delete project"
  destructive
  busy={$deleteMutation.isPending}
  onConfirm={() => $deleteMutation.mutate()}
/>
