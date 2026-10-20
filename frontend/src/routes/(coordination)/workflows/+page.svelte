<script lang="ts">
  import { createQuery, createMutation, useQueryClient, keepPreviousData } from "@tanstack/svelte-query";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { workflowsApi, workflowKeys } from "$lib/api/workflows";
  import { authStore } from "$lib/stores/auth";
  import { PageShell, Toolbar, DataTable, StateBlock, SaveState, Timestamp } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import * as Table from "$lib/components/ui/table";
  import WorkflowStatus from "$lib/components/workflows/WorkflowStatus.svelte";
  const client = useQueryClient();
  const canRead = $derived($authStore.can("workflows.read")), canManage = $derived($authStore.can("workflows.manage"));
  const filterValues = $derived({ search: $page.url.searchParams.get("search") ?? "", status: $page.url.searchParams.get("status") ?? "", cursor: $page.url.searchParams.get("cursor") ?? "" });
  let search = $state("");
  $effect(() => { search = filterValues.search; });
  const stateQuery = createQuery(reactiveOptions(() => ({ queryKey: workflowKeys.state, queryFn: workflowsApi.state, enabled: canRead })));
  const list = createQuery(reactiveOptions(() => ({ queryKey: workflowKeys.list(filterValues), queryFn: ({ signal }: { signal: AbortSignal }) => workflowsApi.list(filterValues, signal), enabled: canRead, placeholderData: keepPreviousData })));
  let toggleRequest = $state<{ enabled: boolean; id: string } | null>(null);
  const toggle = createMutation({ mutationFn: (enabled: boolean) => { if (toggleRequest?.enabled !== enabled) toggleRequest = { enabled, id: crypto.randomUUID() }; return workflowsApi.setState(enabled, toggleRequest.id); }, onSuccess: async () => { toggleRequest = null; await client.invalidateQueries({ queryKey: workflowKeys.all }); } });
  function filter(values: Record<string, string>) { const url = new URL($page.url); for (const [k, v] of Object.entries(values)) { if (v) url.searchParams.set(k, v); else url.searchParams.delete(k); } if (!("cursor" in values)) url.searchParams.delete("cursor"); void goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true }); }
</script>
<PageShell title="Workflows" description="Reusable instructions and the evidence from each execution." toggle={$stateQuery.data ? { label: "Workflows enabled", checked: $stateQuery.data.enabled, disabled: !canManage || $toggle.isPending || $stateQuery.isError, onChange: next => $toggle.mutate(next) } : undefined}>
  {#snippet actions()}<Button href={`${base}/workflows/runs`} variant="outline">View runs</Button>{#if canManage}<Button href={`${base}/workflows/new`}>New workflow</Button>{/if}{/snippet}
  {#if !canRead}<StateBlock state="empty" message="Workflow access required" description="Ask an owner for workflows.read to browse definitions and reports." />{:else}
    {#if $stateQuery.isError}<StateBlock state="error" message="Could not load workflow module state." onRetry={() => $stateQuery.refetch()} />{/if}
    {#if $toggle.error}<SaveState error={$toggle.error} />{/if}
    {#if $stateQuery.data && !$stateQuery.data.enabled}<div class="rounded-md border bg-muted p-3 text-body-sm"><p class="font-semibold">Workflows are disabled</p><p>New runs and invitations are unavailable. Existing runs can continue, record results and complete evaluation. History remains readable.</p>{#if !canManage}<p>Ask an owner with workflows.manage to enable new work.</p>{/if}</div>{/if}
    {#if $stateQuery.data?.unavailable_reason}<p role="status" class="text-body-sm text-warning-muted-foreground">{$stateQuery.data.unavailable_reason}</p>{/if}
    <form onsubmit={e => { e.preventDefault(); filter({ search }); }}><Toolbar bind:search searchPlaceholder="Find workflows" count={$list.data ? `${$list.data.items.length} on this page` : undefined}>{#snippet filters()}<select aria-label="Workflow status" class="h-9 rounded border border-input bg-background px-2 text-body" value={filterValues.status} onchange={e => filter({ status: e.currentTarget.value })}><option value="">All workflows</option><option value="active">Active</option><option value="archived">Archived</option></select><Button type="submit" variant="outline">Search</Button>{/snippet}</Toolbar></form>
    <DataTable items={$list.data?.items} loading={$list.isFetching} error={$list.error?.message} onRetry={() => $list.refetch()} emptyTitle="No workflows created" emptyDescription="Create a reusable instruction with one goal and one or more tasks." filtered={!!(filterValues.search || filterValues.status)} onClearFilters={() => filter({ search: "", status: "" })} caption="Workflow catalog">
      {#snippet head()}<Table.Head>Workflow</Table.Head><Table.Head>Version</Table.Head><Table.Head>Status</Table.Head><Table.Head>Updated</Table.Head>{/snippet}
      {#snippet row(item)}<Table.Row><Table.Cell><a class="font-medium underline underline-offset-4" href={`${base}/workflows/definitions/${encodeURIComponent(item.slug)}`}>{item.title}</a><p class="mt-1 max-w-xl break-words text-body-sm text-muted-foreground">{item.summary}</p></Table.Cell><Table.Cell>{item.version}</Table.Cell><Table.Cell><WorkflowStatus value={item.status} /></Table.Cell><Table.Cell><Timestamp value={item.updated_at} /></Table.Cell></Table.Row>{/snippet}
    </DataTable>
    <div class="flex flex-wrap items-center gap-2">{#if filterValues.cursor}<Button variant="outline" onclick={() => filter({ cursor: "" })}>First page</Button>{/if}{#if $list.data?.next_cursor != null}<Button variant="outline" onclick={() => filter({ cursor: String($list.data!.next_cursor) })}>Next page</Button>{/if}<a class="ml-auto text-body-sm underline" href={`${base}/workflows/runs?evaluation=pending`}>Runs awaiting evaluation</a></div>
  {/if}
</PageShell>
