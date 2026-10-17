<script lang="ts">
  import { page } from "$app/state";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import { ListDetail, Toolbar } from "$lib/components/page";
  import { Badge, type BadgeVariant } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import FilterSelect from "$lib/components/feedback/FilterSelect.svelte";
  import NewProjectReportDialog from "$lib/components/feedback/NewProjectReportDialog.svelte";
  import ReportInbox from "$lib/components/feedback/ReportInbox.svelte";
  import { controlClass, type ReportRow } from "$lib/components/feedback/report-model";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { ApiError } from "$lib/api/client";
  import { fetchFeedback, projectKeys, updateFeedback } from "$lib/api/projects";
  import { relativeTime } from "$lib/utils/format";
  import type { ProjectFeedback, ProjectFeedbackStatus, ProjectFeedbackType } from "$lib/api/types";

  const qc = useQueryClient();
  const slug = $derived(page.params.slug ?? "");

  const TYPES: ProjectFeedbackType[] = ["feature", "bug", "issue", "test", "note"];
  // `status` once had no writer anywhere, so every item ever filed was still open. A review inbox that cannot be closed is a list nobody reads.
  const STATUSES: ProjectFeedbackStatus[] = ["open", "acknowledged", "resolved", "dismissed"];
  const STATUS_BADGE: Record<ProjectFeedbackStatus, BadgeVariant> = { open: "destructive", acknowledged: "default", resolved: "success", dismissed: "outline" };
  const TYPE_BADGE: Record<ProjectFeedbackType, BadgeVariant> = { feature: "default", bug: "destructive", note: "secondary", issue: "destructive", test: "outline" };
  const statusOf = (entry: ProjectFeedback): ProjectFeedbackStatus => entry.status ?? "open";

  let search = $state("");
  let statusFilter = $state("");
  let typeFilter = $state("");
  let newOpen = $state(false);
  let detailOpen = $state(false);
  let selected = $state("");

  const feedbackQuery = createQuery(
    reactiveOptions(() => ({ queryKey: projectKeys.feedback(slug), queryFn: () => fetchFeedback(slug), enabled: slug.length > 0 })),
  );

  const all = $derived(
    [...($feedbackQuery.data?.feedback ?? [])].sort((a, b) => (b.created_at ? Date.parse(b.created_at) : 0) - (a.created_at ? Date.parse(a.created_at) : 0)),
  );
  const openCount = $derived(all.filter((entry) => statusOf(entry) === "open").length);
  const shown = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((entry) =>
      (!statusFilter || statusOf(entry) === statusFilter) &&
      (!typeFilter || entry.type === typeFilter) &&
      (!needle || `${entry.title} ${entry.body}`.toLowerCase().includes(needle)));
  });
  const rows = $derived<ReportRow[]>(
    shown.map((entry) => ({
      id: String(entry.id),
      title: entry.title,
      badges: [{ label: entry.type, variant: TYPE_BADGE[entry.type] ?? "default" }, { label: statusOf(entry), variant: STATUS_BADGE[statusOf(entry)] }],
      meta: relativeTime(entry.created_at),
    })),
  );
  const entry = $derived(all.find((candidate) => String(candidate.id) === selected));

  const statusMut = createMutation({
    mutationFn: ({ id, status }: { id: number; status: ProjectFeedbackStatus }) => updateFeedback(slug, id, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: projectKeys.feedback(slug) });
      const previous = qc.getQueryData(projectKeys.feedback(slug));
      qc.setQueryData<{ project: string | null; feedback: ProjectFeedback[] }>(projectKeys.feedback(slug), (prev) => ({
        project: prev?.project ?? slug,
        feedback: (prev?.feedback ?? []).map((f) => (f.id === id ? { ...f, status } : f)),
      }));
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(projectKeys.feedback(slug), ctx.previous);
      toast.error(err instanceof ApiError ? err.message : "Could not update report");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: projectKeys.feedback(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.detail(slug) });
    },
  });
</script>

<div class="space-y-3">
  <Toolbar bind:search searchPlaceholder="Search reports" count={`${shown.length} of ${all.length} reports${openCount > 0 ? ` · ${openCount} open` : ""}`}>
    {#snippet filters()}
      <FilterSelect label="Filter status" bind:value={statusFilter} options={STATUSES} allLabel="All statuses" />
      <FilterSelect label="Filter type" bind:value={typeFilter} options={TYPES} allLabel="All types" />
    {/snippet}
    {#snippet actions()}
      <Button onclick={() => (newOpen = true)}><Plus class="h-4 w-4" /> New report</Button>
    {/snippet}
  </Toolbar>

  <ListDetail bind:open={detailOpen} title={entry?.title ?? "Report"} description="Change its status as the work progresses.">
    {#snippet list()}
      <ReportInbox
        items={rows}
        loading={$feedbackQuery.isLoading}
        error={$feedbackQuery.isError ? ($feedbackQuery.error instanceof ApiError ? $feedbackQuery.error.message : "Could not load reports") : null}
        onRetry={() => void $feedbackQuery.refetch()}
        selectedId={selected}
        onSelect={(id) => { selected = id; detailOpen = true; }}
        filtered={all.length > 0}
        emptyTitle="No reports yet"
        emptyDescription="Feature requests, issues and test results for this project appear here."
      />
    {/snippet}
    {#snippet detail()}
      {#if entry}
        <div class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant={TYPE_BADGE[entry.type] ?? "default"}>{entry.type}</Badge>
            <Badge variant={STATUS_BADGE[statusOf(entry)]}>{statusOf(entry)}</Badge>
            <span class="text-caption text-muted-foreground">{relativeTime(entry.created_at)}</span>
          </div>
          <p class="whitespace-pre-wrap break-words text-body">{entry.body}</p>
          {#if entry.id > 0}
            <div class="grid gap-1.5">
              <label for="project-report-status" class="text-body-sm font-medium">Status</label>
              <select
                id="project-report-status"
                class="{controlClass} sm:w-56"
                value={statusOf(entry)}
                onchange={(e) => $statusMut.mutate({ id: entry.id, status: e.currentTarget.value as ProjectFeedbackStatus })}
              >
                {#each STATUSES as value (value)}<option {value}>{value}</option>{/each}
              </select>
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </ListDetail>
</div>

<NewProjectReportDialog {slug} bind:open={newOpen} />
