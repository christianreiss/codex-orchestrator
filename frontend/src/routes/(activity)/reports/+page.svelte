<script lang="ts">
  import FeedbackSettings from "$lib/components/feedback/FeedbackSettings.svelte";
  import type { Snapshot } from "./$types";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { PageShell, ListDetail, Toolbar } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { authStore } from "$lib/stores/auth";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import FilterSelect from "$lib/components/feedback/FilterSelect.svelte";
  import NewReportDialog from "$lib/components/feedback/NewReportDialog.svelte";
  import ReportDetail from "$lib/components/feedback/ReportDetail.svelte";
  import ReportInbox from "$lib/components/feedback/ReportInbox.svelte";
  import { feedbackRow, type ReportRow } from "$lib/components/feedback/report-model";
  import {
    feedbackApi, feedbackKeys, feedbackPriorities, feedbackStatuses, feedbackTypes,
    type FeedbackFilters,
  } from "$lib/api/feedback";

  const PAGE = 25;
  const qc = useQueryClient();
  const canManage = $derived($authStore.can("feedback.manage"));

  let search = $state("");
  let status = $state("open");
  let type = $state("");
  let priority = $state("");
  let component = $state("");
  let versionState = $state("");
  let reviewState = $state("");
  let deliveryState = $state("");
  let offset = $state(0);
  let selected = $state("");
  let detailOpen = $state(false);
  let newOpen = $state(false);

  const listFilters = $derived<FeedbackFilters>({
    version_state: versionState || undefined, review_state: reviewState || undefined, delivery_state: deliveryState || undefined,
    query: search || undefined, status: status || undefined, type: type || undefined,
    priority: priority || undefined, component: component || undefined, limit: PAGE, offset,
  });
  const filtered = $derived(Boolean(search || status || type || priority || component || versionState || reviewState || deliveryState));
  // A new filter always starts at the first page.
  $effect(() => { void [search, status, type, priority, component, versionState, reviewState, deliveryState]; offset = 0; });

  const stateQuery = createQuery({ queryKey: feedbackKeys.state, queryFn: feedbackApi.state });
  const listQuery = createQuery(
    reactiveOptions(() => ({ queryKey: feedbackKeys.list(listFilters), queryFn: () => feedbackApi.list(listFilters) })),
  );
  const enabled = $derived($stateQuery.data?.enabled ?? false);
  const refresh = () => qc.invalidateQueries({ queryKey: feedbackKeys.all });

  const stateMutation = createMutation({
    mutationFn: feedbackApi.setEnabled,
    onSuccess: () => { void refresh(); void qc.invalidateQueries({ queryKey: ["agents"] }); toast.success("Agent reporting saved; agent instructions update on the next sync"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = $derived<ReportRow[] | undefined>($listQuery.data?.feedback?.map(feedbackRow));

  function select(id: string) { selected = id; detailOpen = true; }
  export const snapshot: Snapshot<{ search: typeof search, status: typeof status, type: typeof type, priority: typeof priority, component: typeof component, versionState: typeof versionState, reviewState: typeof reviewState, deliveryState: typeof deliveryState, offset: typeof offset, selected: typeof selected }> = {
    capture: () => ({ search, status, type, priority, component, versionState, reviewState, deliveryState, offset, selected }),
    restore: (value) => { search = value.search; status = value.status; type = value.type; priority = value.priority; component = value.component; versionState = value.versionState; reviewState = value.reviewState; deliveryState = value.deliveryState; offset = value.offset; selected = value.selected; },
  };
</script>

<PageShell
  title="Reports"
  description="Bugs, missing features and verified improvements for the orchestrator itself."
  toggle={{
    label: "Agent reports",
    checked: enabled,
    disabled: !canManage || $stateMutation.isPending || $stateQuery.isPending,
    onChange: (next) => $stateMutation.mutate(next),
  }}
>
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => void refresh()}><RefreshCw class="h-4 w-4" /> Refresh</Button>
    <Button size="sm" disabled={!canManage} onclick={() => (newOpen = true)}><Plus class="h-4 w-4" /> New report</Button>
  {/snippet}

  {#if $stateQuery.isError}<p role="alert" class="text-body-sm text-destructive">{$stateQuery.error.message}</p>{/if}

  <FeedbackSettings {canManage} reportingEnabled={enabled} />

  <Toolbar bind:search searchPlaceholder="Search reports">
    {#snippet filters()}
      <FilterSelect label="Filter status" bind:value={status} options={feedbackStatuses} allLabel="All statuses" />
      <FilterSelect label="Filter type" bind:value={type} options={feedbackTypes} allLabel="All types" />
      <FilterSelect label="Filter priority" bind:value={priority} options={feedbackPriorities} allLabel="All priorities" />
      <FilterSelect label="Filter version" bind:value={versionState} options={["old_version", "recent", "unknown"]} allLabel="All versions" />
      <FilterSelect label="Filter review" bind:value={reviewState} options={["pending", "needs_retest", "new", "known", "fixed", "discarded", "unclear"]} allLabel="All reviews" />
      <FilterSelect label="Filter delivery" bind:value={deliveryState} options={["local", "pending", "sent", "uncertain", "failed"]} allLabel="All delivery states" />
      <Input bind:value={component} placeholder="Component" aria-label="Filter component" class="w-36" />
    {/snippet}
  </Toolbar>

  <ListDetail bind:open={detailOpen} title="Report" description="Evidence, triage and history">
    {#snippet list()}
      <ReportInbox
        items={rows}
        loading={$listQuery.isPending}
        error={$listQuery.isError ? $listQuery.error.message : null}
        onRetry={() => void $listQuery.refetch()}
        selectedId={selected}
        onSelect={select}
        {filtered}
        onClearFilters={() => { search = ""; status = ""; type = ""; priority = ""; component = ""; versionState = ""; reviewState = ""; deliveryState = ""; offset = 0; }}
        emptyTitle="No reports yet"
        emptyDescription={enabled ? "Agents and administrators can file reports here." : "Agent reporting is off. Existing reports stay available."}
      >
        {#snippet footer()}
          {#if offset > 0 || $listQuery.data?.next_offset != null}
          <div class="mt-2 flex items-center justify-between">
            <Button variant="outline" size="sm" disabled={offset === 0} onclick={() => (offset = Math.max(0, offset - PAGE))}>Previous</Button>
            <span class="text-caption text-muted-foreground">Page {Math.floor(offset / PAGE) + 1}</span>
            <Button variant="outline" size="sm" disabled={$listQuery.data?.next_offset == null} onclick={() => (offset = $listQuery.data?.next_offset ?? offset)}>Next</Button>
          </div>
          {/if}
        {/snippet}
      </ReportInbox>
    {/snippet}
    {#snippet detail()}
      {#if selected}<ReportDetail id={selected} {canManage} onDeleted={() => { detailOpen = false; selected = ""; }} />{/if}
    {/snippet}
  </ListDetail>
</PageShell>

<NewReportDialog bind:open={newOpen} disabled={!canManage} onCreated={(id) => { status = ""; select(id); }} />
