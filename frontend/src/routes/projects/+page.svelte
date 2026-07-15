<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";
  import * as Alert from "$lib/components/ui/alert";
  import { Skeleton } from "$lib/components/ui/skeleton";
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
</script>

<PageHeader title="Projects" subtitle="Coordination workspaces">
  {#snippet actions()}
    <Button onclick={() => (dialogOpen = true)} disabled={!enabled}>
      <Plus class="h-4 w-4" />
      New project
    </Button>
  {/snippet}
</PageHeader>

<div class="mb-6 flex items-center justify-between gap-3 rounded-xl border border-border/75 bg-card p-4 shadow-sm">
  <div class="flex flex-col">
    <Label for="projects-enabled" class="text-sm font-medium">Project coordination</Label>
    <span class="text-xs text-muted-foreground">
      {enabled
        ? "Module is enabled. Hosts can create and update workspaces."
        : "Module is disabled. List is read-only."}
    </span>
  </div>
  <Switch
    id="projects-enabled"
    checked={enabled}
    disabled={$stateQuery.isLoading || $stateMutation.isPending}
    onCheckedChange={(next) => $stateMutation.mutate(next)}
  />
</div>

{#if !enabled && !$stateQuery.isLoading}
  <Alert.Root variant="warning" class="mb-6">
    <Alert.Title>Project coordination is disabled</Alert.Title>
    <Alert.Description>
      Enable the module above to allow projects to be created, edited, or queried.
    </Alert.Description>
  </Alert.Root>
{/if}

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
  <div class="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/40 py-16 text-center">
    <p class="text-sm text-muted-foreground">No projects yet.</p>
    <Button variant="outline" disabled={!enabled} onclick={() => (dialogOpen = true)}>
      <Plus class="h-4 w-4" />
      Create the first project
    </Button>
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

<NewProjectDialog bind:open={dialogOpen} />

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
