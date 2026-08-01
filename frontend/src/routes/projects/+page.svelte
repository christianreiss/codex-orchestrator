<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import Search from "@lucide/svelte/icons/search";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import FolderKanban from "@lucide/svelte/icons/folder-kanban";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import ModuleSwitchRow from "$lib/components/layout/ModuleSwitchRow.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Alert from "$lib/components/ui/alert";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { Input } from "$lib/components/ui/input";
  import { relativeTime } from "$lib/utils/format";
  import * as Table from "$lib/components/ui/table";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
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
  let search = $state("");
  type SortKey = "title" | "updated" | "activity";
  let sortKey = $state<SortKey>("updated");
  let sortDir = $state<"asc" | "desc">("desc");
  const visibleProjects = $derived.by(() => {
    const query = search.trim().toLowerCase();
    const rows = query
      ? projects.filter((project) => [project.title, project.slug, project.description].some((value) => value?.toLowerCase().includes(query)))
      : projects;
    const direction = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = sortKey === "title" ? (a.title || a.slug) : sortKey === "updated" ? (a.updated_at ?? "") : String(a.latest_seq ?? 0).padStart(16, "0");
      const right = sortKey === "title" ? (b.title || b.slug) : sortKey === "updated" ? (b.updated_at ?? "") : String(b.latest_seq ?? 0).padStart(16, "0");
      return left.localeCompare(right) * direction;
    });
  });
  function toggleSort(next: SortKey) {
    if (sortKey === next) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = next; sortDir = next === "title" ? "asc" : "desc"; }
  }

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
  <div class="grid grid-cols-1 gap-2 md:grid-cols-3">
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
  <div class="rounded-md border border-dashed bg-card/40">
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
  <div class:opacity-60={!enabled} class="overflow-hidden rounded-md border bg-card">
    <div class="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <label class="relative min-w-[14rem] flex-1 sm:max-w-sm"><Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input bind:value={search} class="h-8 pl-8" placeholder="Search title, slug, or description" aria-label="Search projects" /></label>
      <span class="text-xs text-muted-foreground">{visibleProjects.length} of {projects.length} projects</span>
    </div>
    <Table.Root>
      <Table.Header><Table.Row><SortableHead label="Project" active={sortKey === "title"} dir={sortDir} onclick={() => toggleSort("title")} /><Table.Head>Description</Table.Head><Table.Head class="text-right">Open work</Table.Head><SortableHead label="Activity" active={sortKey === "activity"} dir={sortDir} onclick={() => toggleSort("activity")} /><SortableHead label="Updated" active={sortKey === "updated"} dir={sortDir} onclick={() => toggleSort("updated")} /><Table.Head class="w-10" /></Table.Row></Table.Header>
      <Table.Body>
        {#each visibleProjects as project (project.slug)}
          <Table.Row>
            <Table.Cell><a href={`${base}/projects/${encodeURIComponent(project.slug)}`} class="font-medium hover:text-primary hover:underline">{project.title || project.slug}</a><code class="ml-2 text-xs text-muted-foreground">{project.slug}</code></Table.Cell>
            <Table.Cell class="max-w-xl truncate text-muted-foreground">{project.description || "—"}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{project.counts?.open_todos ?? 0} todos</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{project.latest_seq}</Table.Cell>
            <Table.Cell class="text-muted-foreground">{project.updated_at ? relativeTime(project.updated_at) : "—"}</Table.Cell>
            <Table.Cell class="text-right"><Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`Delete ${project.title || project.slug}`} onclick={() => { projectToDelete = project; confirmOpen = true; }}><Trash2 class="h-4 w-4" /></Button></Table.Cell>
          </Table.Row>
        {:else}
          <Table.Row><Table.Cell colspan={6} class="py-8 text-center text-sm text-muted-foreground">No projects match this filter.</Table.Cell></Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
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
