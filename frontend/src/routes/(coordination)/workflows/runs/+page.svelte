<script lang="ts">
  import { createQuery, keepPreviousData } from "@tanstack/svelte-query";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { workflowsApi, workflowRunKeys } from "$lib/api/workflows";
  import { authStore } from "$lib/stores/auth";
  import { PageShell, Toolbar, DataTable, StateBlock, Timestamp } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Table from "$lib/components/ui/table";
  import WorkflowStatus from "$lib/components/workflows/WorkflowStatus.svelte";
  const canRead = $derived($authStore.can("workflows.read"));
  const filterValues = $derived(Object.fromEntries(["search", "workflow_id", "status", "outcome", "agent_address_id", "evaluation", "cursor"].map(k => [k, $page.url.searchParams.get(k) ?? ""])));
  let search = $state(""), workflow = $state(""), agent = $state("");
  $effect(() => { search = filterValues.search; workflow = filterValues.workflow_id; agent = filterValues.agent_address_id; });
  const list = createQuery(reactiveOptions(() => ({ queryKey: workflowRunKeys.list(filterValues), queryFn: ({ signal }: { signal: AbortSignal }) => workflowsApi.runList(filterValues, signal), enabled: canRead, placeholderData: keepPreviousData })));
  function filter(values: Record<string, string>) { const url = new URL($page.url); for (const [k,v] of Object.entries(values)) v ? url.searchParams.set(k,v) : url.searchParams.delete(k); if (!("cursor" in values)) url.searchParams.delete("cursor"); void goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true }); }
</script>
<PageShell title="Workflow runs" description="Follow active work, resolve uncertainty and inspect completed reports." width="wide">
  {#snippet actions()}<Button href={`${base}/workflows`} variant="outline">Workflow catalog</Button>{/snippet}
  {#if !canRead}<StateBlock state="empty" message="Workflow access required" description="Ask an owner for workflows.read to view runs." />{:else}
    {#if $list.data?.enabled === false}<p class="rounded-md border bg-muted p-3 text-body-sm">Workflows are disabled. Existing runs may finish and be evaluated; their reports remain available.</p>{/if}
    <form class="space-y-3" onsubmit={e => { e.preventDefault(); filter({ search, workflow_id: workflow, agent_address_id: agent.replace(/^agent:/, "") }); }}><Toolbar bind:search searchPlaceholder="Find runs" count={$list.data ? `${$list.data.items.length} on this page` : undefined}>
      {#snippet filters()}<select aria-label="Run status" class="h-9 max-w-full rounded border border-input bg-background px-2 text-body" value={filterValues.status} onchange={e => filter({ status: e.currentTarget.value })}><option value="">All statuses</option>{#each ["pending","running","paused","blocked","evaluating","completed"] as status}<option value={status}>{status}</option>{/each}</select><select aria-label="Run outcome" class="h-9 max-w-full rounded border border-input bg-background px-2 text-body" value={filterValues.outcome} onchange={e => filter({ outcome: e.currentTarget.value })}><option value="">All outcomes</option>{#each ["succeeded","partial","failed","canceled","unknown"] as outcome}<option value={outcome}>{outcome}</option>{/each}</select><select aria-label="Run evaluation" class="h-9 max-w-full rounded border border-input bg-background px-2 text-body" value={filterValues.evaluation} onchange={e => filter({ evaluation: e.currentTarget.value })}><option value="">All evaluations</option><option value="pending">Awaiting evaluation</option><option value="final">Finalized</option></select><Button variant="outline" type="submit">Search</Button>{/snippet}
    </Toolbar><details><summary class="cursor-pointer py-1 text-body-sm">Workflow and participant filters</summary><div class="mt-2 flex flex-wrap gap-3"><label class="text-body-sm">Workflow ID<Input bind:value={workflow} aria-label="Workflow ID" /></label><label class="text-body-sm">Participant address<Input bind:value={agent} aria-label="Participant address" /></label><Button type="submit" variant="outline" class="self-end">Apply filters</Button></div></details></form>
    <DataTable items={$list.data?.items} loading={$list.isFetching} error={$list.error?.message} onRetry={() => $list.refetch()} caption="Workflow runs" emptyTitle="No runs prepared" emptyDescription="Choose a workflow to prepare its first run." filtered={Object.entries(filterValues).some(([k,v]) => k !== "cursor" && !!v)} onClearFilters={() => filter(Object.fromEntries(Object.keys(filterValues).map(k => [k, ""])))}>
      {#snippet head()}<Table.Head>Run</Table.Head><Table.Head>Progress</Table.Head><Table.Head>Outcome</Table.Head><Table.Head>Evaluation</Table.Head><Table.Head>Updated</Table.Head>{/snippet}
      {#snippet row(run)}<Table.Row><Table.Cell><a class="font-medium underline underline-offset-4" href={`${base}/workflows/runs/${run.run_id}`}>{run.title}</a><p class="mt-1 text-body-sm text-muted-foreground">{run.workflow_slug ?? run.workflow_id} · v{run.workflow_version}</p></Table.Cell><Table.Cell><WorkflowStatus value={run.status} /></Table.Cell><Table.Cell>{#if run.outcome}<WorkflowStatus value={run.outcome} />{:else}<span class="text-body-sm text-muted-foreground">Work not finished</span>{/if}</Table.Cell><Table.Cell>{run.evaluation?.status ?? (run.status === "evaluating" ? "Pending" : "Not due")}</Table.Cell><Table.Cell><Timestamp value={run.updated_at} /></Table.Cell></Table.Row>{/snippet}
    </DataTable>
    <div class="flex gap-2">{#if filterValues.cursor}<Button variant="outline" onclick={() => filter({ cursor: "" })}>First page</Button>{/if}{#if $list.data?.next_cursor != null}<Button variant="outline" onclick={() => filter({ cursor: String($list.data!.next_cursor) })}>Next page</Button>{/if}</div>
  {/if}
</PageShell>
