<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import FolderKanban from "@lucide/svelte/icons/folder-kanban";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import ModuleSwitchRow from "$lib/components/layout/ModuleSwitchRow.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Alert from "$lib/components/ui/alert";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import ProjectCard from "$lib/components/projects/ProjectCard.svelte";
  import ConfirmDialog from "$lib/components/projects/ConfirmDialog.svelte";
  import NewProjectDialog from "$lib/components/projects/NewProjectDialog.svelte";
  import { ApiError } from "$lib/api/client";
  import {
    deleteProject,
    fetchProjects,
    fetchProjectsState,
    projectKeys,
    updateProjectsState,
  } from "$lib/api/projects";
  import type { ProjectSummary } from "$lib/api/types";

  const qc = useQueryClient();
  let dialogOpen = $state(false);
  let confirmOpen = $state(false);
  let projectToDelete = $state<ProjectSummary | null>(null);

  const stateQuery = createQuery({
    queryKey: projectKeys.state,
    queryFn: fetchProjectsState,
  });

  const listQuery = createQuery({
    queryKey: projectKeys.list,
    queryFn: fetchProjects,
  });

  const stateMutation = createMutation({
    mutationFn: (enabled: boolean) => updateProjectsState(enabled),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: projectKeys.state });
      const previous = qc.getQueryData(projectKeys.state);
      qc.setQueryData(projectKeys.state, (prev: unknown) =>
        prev && typeof prev === "object" ? { ...(prev as object), enabled } : { enabled },
      );
      return { previous };
    },
    onError: (err, _v, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(projectKeys.state, context.previous);
      }
      toast.error(err instanceof ApiError ? err.message : "Could not update module state");
    },
    onSuccess: () => {
      toast.success("Module state updated");
      void qc.invalidateQueries({ queryKey: projectKeys.list });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.state });
    },
  });

  const deleteMutation = createMutation({
    mutationFn: (project: ProjectSummary) => deleteProject(project.slug),
    onSuccess: (_data, project) => {
      toast.success(`Deleted project ${project.slug}`);
      confirmOpen = false;
      projectToDelete = null;
      void qc.invalidateQueries({ queryKey: projectKeys.list });
      void qc.removeQueries({ queryKey: projectKeys.detail(project.slug) });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Could not delete project");
    },
  });

  const enabled = $derived(($stateQuery.data?.enabled ?? false) === true);
  const projects = $derived($listQuery.data?.projects ?? []);
  const deleteTitle = $derived(projectToDelete?.title || projectToDelete?.slug || "this project");

  function clearDialogParam(): void {
    if (page.url.searchParams.get("dialog") !== "new") return;
    const url = new URL(page.url);
    url.searchParams.delete("dialog");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  let handledDisabledRequest = $state(false);
  $effect(() => {
    const requested = page.url.searchParams.get("dialog") === "new";
    const loading = $stateQuery.isLoading;
    if (!requested) {
      handledDisabledRequest = false;
      return;
    }
    if (loading) return;
    if (enabled) {
      dialogOpen = true;
      return;
    }
    if (!handledDisabledRequest) {
      handledDisabledRequest = true;
      toast.info("Enable Project coordination before creating a project.");
      clearDialogParam();
    }
  });
</script>

<PageHeader title="Projects" subtitle="Coordination workspaces">
  {#snippet actions()}
    <Button onclick={() => (dialogOpen = true)} disabled={!enabled}>
      <Plus class="h-4 w-4" />
      New project
    </Button>
  {/snippet}
</PageHeader>

<ModuleSwitchRow
  id="projects-enabled"
  label="Project coordination"
  description={enabled
    ? "Module is enabled. Hosts can create and update workspaces."
    : "Module is disabled. List is read-only."}
  checked={enabled}
  disabled={$stateQuery.isLoading || $stateMutation.isPending}
  onCheckedChange={(next) => $stateMutation.mutate(next)}
  class="mb-6"
/>

{#if $listQuery.isLoading}
  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
    {#each Array(3) as _, i (i)}
      <Skeleton class="h-40 w-full" />
    {/each}
  </div>
{:else if $listQuery.isError}
  <Alert.Root variant="destructive">
    <Alert.Title>Could not load projects</Alert.Title>
    <Alert.Description>
      {$listQuery.error instanceof ApiError ? $listQuery.error.message : "Unknown error"}
    </Alert.Description>
  </Alert.Root>
{:else if projects.length === 0}
  <div class="rounded-xl border border-dashed bg-card/40">
    <EmptyState
      icon={FolderKanban}
      title="No projects yet"
      description="Projects are shared workspaces agents coordinate through."
    >
      {#snippet action()}
        <Button disabled={!enabled} onclick={() => (dialogOpen = true)}>
          <Plus class="h-4 w-4" />
          Create project
        </Button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div
    class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
    class:opacity-60={!enabled}
  >
    {#each projects as project (project.slug)}
      <ProjectCard
        {project}
        onDelete={(target) => {
          projectToDelete = target;
          confirmOpen = true;
        }}
      />
    {/each}
  </div>
{/if}

<NewProjectDialog
  bind:open={dialogOpen}
  onOpenChange={(next) => {
    dialogOpen = next;
    if (!next) clearDialogParam();
  }}
/>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Delete project?"
  description={`This permanently removes ${deleteTitle} and all of its notes, todos, files, and feedback.`}
  confirmLabel="Delete project"
  destructive
  busy={$deleteMutation.isPending}
  onClose={() => {
    if (!$deleteMutation.isPending && !confirmOpen) projectToDelete = null;
  }}
  onConfirm={() => {
    if (projectToDelete) $deleteMutation.mutate(projectToDelete);
  }}
/>
