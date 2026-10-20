<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { page } from "$app/stores";
  import { base } from "$app/paths";
  import { authStore } from "$lib/stores/auth";
  import { workflowKeys, workflowsApi } from "$lib/api/workflows";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import WorkflowEditor from "$lib/components/workflows/WorkflowEditor.svelte";
  const canRead = $derived($authStore.can("workflows.read")), canManage = $derived($authStore.can("workflows.manage"));
  const from = $derived($page.url.searchParams.get("from") ?? "");
  const moduleQuery = createQuery(reactiveOptions(() => ({ queryKey: workflowKeys.state, queryFn: workflowsApi.state, enabled: canRead })));
  const source = createQuery(reactiveOptions(() => ({ queryKey: workflowKeys.definition(from), queryFn: () => workflowsApi.get(from), enabled: canRead && !!from })));
</script>
<PageShell title="New workflow" description="Define a goal, the work to reach it and the evidence each task must produce." width="narrow">
  {#snippet actions()}<Button href={`${base}/workflows`} variant="outline">Back to workflows</Button>{/snippet}
  {#if !canRead}<StateBlock state="empty" message="Workflow access required" />{:else if $moduleQuery.isPending || (from && $source.isPending)}<StateBlock state="loading" />{:else if $moduleQuery.isError || (from && $source.isError)}<StateBlock state="error" message="Could not load workflow editor." onRetry={() => { void $moduleQuery.refetch(); if (from) void $source.refetch(); }} />{:else}<WorkflowEditor definition={$source.data} asNew {canManage} enabled={$moduleQuery.data?.enabled ?? false} />{/if}
</PageShell>
