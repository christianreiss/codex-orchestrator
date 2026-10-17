<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import Settings from "@lucide/svelte/icons/settings";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import FolderKanban from "@lucide/svelte/icons/folder-kanban";
  import { PageShell, Toolbar, DataTable } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Badge } from "$lib/components/ui/badge";
  import * as Table from "$lib/components/ui/table";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import NewProjectDialog from "$lib/components/projects/NewProjectDialog.svelte";
  import ProjectSettingsSheet from "$lib/components/projects/ProjectSettingsSheet.svelte";
  import { PROJECT_SORTS, visibleProjects, type ProjectSort } from "$lib/components/projects/project-list";
  import { filterClass } from "$lib/components/feedback/report-model";
  import { relativeTime } from "$lib/utils/format";
  import { ApiError } from "$lib/api/client";
  import { deleteProject, fetchProjects, fetchProjectsState, projectKeys, updateProjectsState } from "$lib/api/projects";
  import type { ProjectSummary } from "$lib/api/types";

  const qc = useQueryClient();
  let dialogOpen = $state(false);
  let settingsOpen = $state(false);
  let confirmOpen = $state(false);
  let projectToDelete = $state<ProjectSummary | null>(null);
  let search = $state("");
  let sort = $state<ProjectSort>("updated");
  // The admin list returns archived projects too, because the console is where you find one again.
  // Hidden by default so a finished project stops competing with live work.
  let showArchived = $state(false);

  const stateQuery = createQuery({ queryKey: projectKeys.state, queryFn: fetchProjectsState });
  const listQuery = createQuery({ queryKey: projectKeys.list, queryFn: fetchProjects });

  const stateMutation = createMutation({
    mutationFn: (enabled: boolean) => updateProjectsState(enabled),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: projectKeys.state });
      const previous = qc.getQueryData(projectKeys.state);
      qc.setQueryData(projectKeys.state, (prev: unknown) => (prev && typeof prev === "object" ? { ...(prev as object), enabled } : { enabled }));
      return { previous };
    },
    onError: (err, _v, context) => {
      if (context?.previous !== undefined) qc.setQueryData(projectKeys.state, context.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not update module state");
    },
    onSuccess: () => { toast.success("Module state updated"); void qc.invalidateQueries({ queryKey: projectKeys.list }); },
    onSettled: () => void qc.invalidateQueries({ queryKey: projectKeys.state }),
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
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not delete project"),
  });

  const enabled = $derived(($stateQuery.data?.enabled ?? false) === true);
  const projects = $derived($listQuery.data?.projects ?? []);
  const archivedCount = $derived(projects.filter((p) => p.archived_at).length);
  const rows = $derived(visibleProjects(projects, { query: search, showArchived, sort }));
  const deleteTitle = $derived(projectToDelete?.title || projectToDelete?.slug || "this project");

  function clearDialogParam(): void {
    if (page.url.searchParams.get("dialog") !== "new") return;
    const url = new URL(page.url);
    url.searchParams.delete("dialog");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  // `?dialog=new` (from the command palette) opens the dialog once the module state is known.
  let handledDisabledRequest = $state(false);
  $effect(() => {
    const requested = page.url.searchParams.get("dialog") === "new";
    if (!requested) { handledDisabledRequest = false; return; }
    if ($stateQuery.isLoading) return;
    if (enabled) { dialogOpen = true; return; }
    if (!handledDisabledRequest) {
      handledDisabledRequest = true;
      toast.info("Enable Project coordination before creating a project.");
      clearDialogParam();
    }
  });
</script>

<PageShell
  title="Projects"
  description="Shared workspaces agents coordinate through."
  toggle={{
    label: "Project coordination",
    checked: enabled,
    disabled: $stateQuery.isLoading || $stateMutation.isPending,
    onChange: (next) => $stateMutation.mutate(next),
  }}
>
  {#snippet actions()}
    <Button variant="outline" size="icon" aria-label="Project settings" onclick={() => (settingsOpen = true)}><Settings class="h-4 w-4" /></Button>
    <Button onclick={() => (dialogOpen = true)} disabled={!enabled}><Plus class="h-4 w-4" /> New project</Button>
  {/snippet}

  <Toolbar bind:search searchPlaceholder="Search projects" count={`${rows.length} of ${projects.length} projects`}>
    {#snippet filters()}
      {#if archivedCount > 0}
        <label class="flex cursor-pointer items-center gap-2 text-body-sm text-muted-foreground">
          <Checkbox bind:checked={showArchived} aria-label="Show archived projects" />
          Show archived ({archivedCount})
        </label>
      {/if}
      <select class="{filterClass} w-44" aria-label="Sort projects" bind:value={sort}>
        {#each PROJECT_SORTS as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </select>
    {/snippet}
  </Toolbar>

  <div class:opacity-60={!enabled}>
    <DataTable
      items={$listQuery.data ? rows : undefined}
      loading={$listQuery.isLoading}
      error={$listQuery.isError ? ($listQuery.error instanceof ApiError ? $listQuery.error.message : "Could not load projects") : null}
      onRetry={() => void $listQuery.refetch()}
      key={(project) => project.slug}
      filtered={projects.length > 0}
      emptyIcon={FolderKanban}
      emptyTitle="No projects yet"
      emptyDescription="Projects are shared workspaces agents coordinate through."
      caption="Projects"
    >
      {#snippet emptyAction()}
        <Button disabled={!enabled} onclick={() => (dialogOpen = true)}><Plus class="h-4 w-4" /> Create project</Button>
      {/snippet}
      {#snippet head()}
        <Table.Head>Project</Table.Head>
        <Table.Head class="hidden md:table-cell">Description</Table.Head>
        <Table.Head class="text-right">Open work</Table.Head>
        <Table.Head class="hidden sm:table-cell">Updated</Table.Head>
        <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
      {/snippet}
      {#snippet row(project: ProjectSummary)}
        <Table.Row>
          <Table.Cell>
            <a href={`${base}/projects/${encodeURIComponent(project.slug)}`} class="font-medium hover:text-primary hover:underline">{project.title || project.slug}</a>
            {#if project.title && project.title !== project.slug}<code class="ml-2 text-caption text-muted-foreground">{project.slug}</code>{/if}
            {#if project.archived_at}<Badge variant="outline" class="ml-2">Archived</Badge>{/if}
          </Table.Cell>
          <Table.Cell class="hidden max-w-md truncate text-muted-foreground md:table-cell">{project.description || "—"}</Table.Cell>
          <Table.Cell class="text-right tabular-nums {(project.counts?.open_todos ?? 0) > 0 ? 'font-medium' : 'text-muted-foreground'}">{project.counts?.open_todos ?? 0}</Table.Cell>
          <Table.Cell class="hidden text-muted-foreground sm:table-cell">{project.updated_at ? relativeTime(project.updated_at) : "—"}</Table.Cell>
          <Table.Cell class="text-right">
            <RowActions
              label={`Actions for ${project.title || project.slug}`}
              actions={[{ label: "Delete project", icon: Trash2, destructive: true, onClick: () => { projectToDelete = project; confirmOpen = true; } }]}
            />
          </Table.Cell>
        </Table.Row>
      {/snippet}
    </DataTable>
  </div>
</PageShell>

<NewProjectDialog bind:open={dialogOpen} onOpenChange={(next) => { dialogOpen = next; if (!next) clearDialogParam(); }} />
<ProjectSettingsSheet bind:open={settingsOpen} />

<ConfirmDialog
  bind:open={confirmOpen}
  title="Delete project?"
  description={`This permanently removes ${deleteTitle} and all of its notes, board cards, files, and reports.`}
  confirmLabel="Delete project"
  destructive
  busy={$deleteMutation.isPending}
  onClose={() => { if (!$deleteMutation.isPending && !confirmOpen) projectToDelete = null; }}
  onConfirm={() => { if (projectToDelete) $deleteMutation.mutate(projectToDelete); }}
/>
