<script lang="ts">
  import { createQuery, keepPreviousData } from "@tanstack/svelte-query";
  import { untrack } from "svelte";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { base } from "$app/paths";
  import { workflowsApi, workflowRunKeys, workflowKeys } from "$lib/api/workflows";
  import { agentMessagingAddressesQuery } from "$lib/api/agentMessaging";
  import { authStore } from "$lib/stores/auth";
  import { UrlFilters } from "$lib/utils/url-filters.svelte";
  import { PageShell, Toolbar, DataTable, StateBlock, Timestamp } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { SimpleSelect } from "$lib/components/ui/select";
  import * as Table from "$lib/components/ui/table";
  import WorkflowStatus from "$lib/components/workflows/WorkflowStatus.svelte";
  import { statusLabel } from "$lib/components/workflows/helpers";
  import { engineLabel } from "$lib/constants/engines";
  const canRead = $derived($authStore.can("workflows.read"));
  // `cursor` rides along in the URL so Back from a run restores the page; any other filter resets it.
  const filterState = new UrlFilters({ search: "", workflow_id: "", status: "", outcome: "", agent_address_id: "", evaluation: "", cursor: "" });
  const criteria = $derived(JSON.stringify({ ...filterState.values, cursor: "" }));
  let seen = untrack(() => criteria);
  $effect(() => { const now = criteria; if (now !== seen) { seen = now; filterState.values.cursor = ""; } });
  const filterValues = $derived({ ...filterState.values });
  const list = createQuery(reactiveOptions(() => ({ queryKey: workflowRunKeys.list(filterValues), queryFn: ({ signal }: { signal: AbortSignal }) => workflowsApi.runList(filterValues, signal), enabled: canRead, placeholderData: keepPreviousData })));
  const workflows = createQuery(reactiveOptions(() => ({ queryKey: workflowKeys.list({}), queryFn: ({ signal }: { signal: AbortSignal }) => workflowsApi.list({}, signal), enabled: canRead })));
  const addresses = agentMessagingAddressesQuery();
  const statuses = ["pending", "running", "paused", "blocked", "evaluating", "completed"];
  const outcomes = ["succeeded", "partial", "failed", "canceled", "unknown"];
  const choose = (all: string, items: { value: string; label: string }[]) => [{ value: "", label: all }, ...items];
  const workflowOptions = $derived(choose("All workflows", ($workflows.data?.items ?? []).map((w) => ({ value: w.workflow_id, label: w.title }))));
  const agentOptions = $derived(choose("All participants", ($addresses.data?.addresses ?? []).map((a) => ({ value: a.id, label: `${a.name || a.alias || a.username} · ${engineLabel(a.engine)}` }))));
  const only = (value: string, options: { value: string; label: string }[]) => (value && !options.some((o) => o.value === value) ? [...options, { value, label: value }] : options);
</script>
<PageShell title="Workflow runs" description="Follow active work, resolve uncertainty and inspect completed reports." width="wide">
  {#snippet actions()}<Button href={`${base}/workflows`} variant="outline">Workflow catalog</Button>{/snippet}
  {#if !canRead}<StateBlock state="denied" message="Workflow access required" capability="workflows.read" />{:else}
    {#if $list.data?.enabled === false}<p class="rounded-md border bg-muted p-3 text-body-sm">Workflows are disabled. Existing runs may finish and be evaluated; their reports remain available.</p>{/if}
    <Toolbar bind:search={filterState.values.search} searchPlaceholder="Find runs" count={$list.data ? `${$list.data.items.length} on this page` : undefined} filtersActive={filterState.active} onClearFilters={() => filterState.clear()}>
      {#snippet filters()}
        <SimpleSelect aria-label="Run status" bind:value={filterState.values.status} options={choose("All statuses", statuses.map((s) => ({ value: s, label: statusLabel(s) })))} />
        <SimpleSelect aria-label="Run outcome" bind:value={filterState.values.outcome} options={choose("All outcomes", outcomes.map((s) => ({ value: s, label: statusLabel(s) })))} />
        <SimpleSelect aria-label="Run evaluation" bind:value={filterState.values.evaluation} options={choose("All evaluations", [{ value: "pending", label: "Awaiting evaluation" }, { value: "final", label: "Finalized" }])} />
        <SimpleSelect aria-label="Workflow" bind:value={filterState.values.workflow_id} options={only(filterState.values.workflow_id, workflowOptions)} />
        <SimpleSelect aria-label="Participant" bind:value={filterState.values.agent_address_id} options={only(filterState.values.agent_address_id, agentOptions)} />
      {/snippet}
    </Toolbar>
    <DataTable items={$list.data?.items} loading={$list.isFetching} error={$list.error} onRetry={() => $list.refetch()} caption="Workflow runs" emptyTitle="No runs prepared" emptyDescription="Choose a workflow to prepare its first run." filtered={filterState.active} onClearFilters={() => filterState.clear()}>
      {#snippet head()}<Table.Head>Run</Table.Head><Table.Head>Progress</Table.Head><Table.Head>Outcome</Table.Head><Table.Head>Evaluation</Table.Head><Table.Head>Updated</Table.Head>{/snippet}
      {#snippet row(run)}<Table.Row><Table.Cell><a class="font-medium underline underline-offset-4" href={`${base}/workflows/runs/${run.run_id}`}>{run.title}</a><p class="mt-1 text-body-sm text-muted-foreground">{run.workflow_slug ?? run.workflow_id} · v{run.workflow_version}</p></Table.Cell><Table.Cell><WorkflowStatus value={run.status} />{#if run.status === "pending" && run.preparation}<p class="mt-1 text-body-sm text-muted-foreground">{run.preparation.phase === "clarifying" ? "Questions to clarify" : run.preparation.phase === "awaiting_confirmation" ? "Awaiting confirmation" : "Ready to execute"}</p>{/if}</Table.Cell><Table.Cell>{#if run.outcome}<WorkflowStatus value={run.outcome} />{:else}<span class="text-body-sm text-muted-foreground">Work not finished</span>{/if}</Table.Cell><Table.Cell>{statusLabel(run.evaluation?.status ?? (run.status === "evaluating" ? "pending" : "not_due"))}</Table.Cell><Table.Cell><Timestamp value={run.updated_at} /></Table.Cell></Table.Row>{/snippet}
    </DataTable>
    <div class="flex gap-2">{#if filterState.values.cursor}<Button variant="outline" onclick={() => (filterState.values.cursor = "")}>First page</Button>{/if}{#if $list.data?.next_cursor != null}<Button variant="outline" onclick={() => (filterState.values.cursor = String($list.data!.next_cursor))}>Next page</Button>{/if}</div>
  {/if}
</PageShell>
