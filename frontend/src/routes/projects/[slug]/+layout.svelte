<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Info from "@lucide/svelte/icons/info";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import ProjectTabsNav from "$lib/components/projects/ProjectTabsNav.svelte";
  import ProjectAboutSheet from "$lib/components/projects/ProjectAboutSheet.svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { archiveProject, deleteProject, fetchProjectSummary, projectKeys, unarchiveProject } from "$lib/api/projects";

  let { children } = $props();

  const qc = useQueryClient();
  const section = $derived(({ board: "Board", documents: "Documents", reports: "Reports", activity: "Activity" } as Record<string, string>)[page.url.pathname.split("/").at(-1) ?? ""] ?? "Board");
  const slug = $derived(page.params.slug ?? "");

  // The lean summary, not `fetchProject`: this query runs on every tab, and the
  // detail response carries every file body (597 KB on one live project).
  const detail = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.summary(slug), queryFn: () => fetchProjectSummary(slug), enabled: slug.length > 0 })),
  );

  let confirmOpen = $state(false);
  let aboutOpen = $state(false);

  const deleteMutation = createMutation({
    mutationFn: () => deleteProject(slug),
    onSuccess: () => {
      toast.success(`Deleted project ${slug}`);
      void qc.invalidateQueries({ queryKey: projectKeys.list });
      void qc.removeQueries({ queryKey: projectKeys.detail(slug) });
      void goto(`${base}/projects`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not delete project"),
  });

  // Archiving is reversible and keeps the project readable, so unlike Delete it needs no confirmation.
  const archiveMutation = createMutation({
    mutationFn: (archive: boolean) => (archive ? archiveProject(slug) : unarchiveProject(slug)),
    onSuccess: (_data, archive) => {
      toast.success(archive ? `Archived ${slug}` : `Reopened ${slug}`);
      void qc.invalidateQueries({ queryKey: projectKeys.list });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not change archive state"),
  });

  const project = $derived($detail.data?.project);
  const archivedAt = $derived(project?.archived_at ?? null);
  const about = $derived((project?.about ?? {}) as Record<string, unknown>);
  const title = $derived(typeof about.title === "string" && about.title ? about.title : slug);
  const blurb = $derived(typeof about.description === "string" ? about.description : "");
  const counts = $derived({
    board: project?.counts?.open_todos,
    documents: (project?.counts?.notes ?? 0) + (project?.counts?.files ?? 0),
    reports: project?.feedback_by_type?.status_open ?? undefined,
  });
</script>

<PageShell {title} width="wide" description={blurb || (slug !== title ? slug : undefined)}>
  {#snippet actions()}
    {#if archivedAt}<Badge variant="outline">Archived</Badge>{/if}
    <Button variant="ghost" size="sm" href="{base}/projects"><ArrowLeft class="h-4 w-4" /> Projects</Button>
    <Button variant="outline" size="sm" onclick={() => (aboutOpen = true)}><Info class="h-4 w-4" /> About</Button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-input bg-card px-2.5 text-body-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
        disabled={!$detail.data}
      >
        <Ellipsis class="h-4 w-4" /> More
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-56">
        <DropdownMenu.Item onclick={() => $archiveMutation.mutate(!archivedAt)} disabled={$archiveMutation.isPending}>
          {#if archivedAt}<ArchiveRestore class="h-4 w-4" /> Reopen project{:else}<Archive class="h-4 w-4" /> Archive project{/if}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onclick={() => (confirmOpen = true)} class="text-destructive focus:bg-destructive-muted focus:text-destructive">
          <Trash2 class="h-4 w-4" /> Delete project
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/snippet}

  {#if $detail.isError}
    <StateBlock state="error" message={$detail.error instanceof ApiError ? $detail.error.message : "Could not load project"} onRetry={() => void $detail.refetch()} />
  {/if}

  <ProjectTabsNav {slug} {counts} />

  <section aria-labelledby="project-section-heading" class="min-w-0 space-y-4">
    <h2 id="project-section-heading" class="text-base font-semibold">{section}</h2>
    {@render children?.()}
  </section>
</PageShell>

<ProjectAboutSheet {slug} bind:open={aboutOpen} />

<ConfirmDialog
  bind:open={confirmOpen}
  title="Delete project?"
  description="This permanently removes {slug} and all of its notes, board cards, files, and reports."
  confirmLabel="Delete project"
  destructive
  busy={$deleteMutation.isPending}
  onConfirm={() => $deleteMutation.mutate()}
/>
