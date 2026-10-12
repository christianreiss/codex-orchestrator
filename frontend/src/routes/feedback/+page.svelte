<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { toast } from 'svelte-sonner';
  import { authStore } from '$lib/stores/auth';
  import { reactiveOptions } from '$lib/components/projects/reactive-options.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import ModuleSwitchRow from '$lib/components/layout/ModuleSwitchRow.svelte';
  import { Button } from '$lib/components/ui/button';
  import { relativeTime } from '$lib/utils/format';
  import {
    feedbackApi, feedbackKeys, feedbackTypes, feedbackStatuses, feedbackPriorities,
    type FeedbackFilters, type FeedbackItem, type FeedbackPriority, type FeedbackType,
  } from '$lib/api/feedback';

  const qc = useQueryClient();
  const canManage = $derived($authStore.can('feedback.manage'));
  const control = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
  let search = $state('');
  let statusFilter = $state('open');
  let typeFilter = $state('');
  let priorityFilter = $state('');
  let componentFilter = $state('');
  let offset = $state(0);
  let selected = $state('');
  let createOpen = $state(false);
  const filters = $derived<FeedbackFilters>({
    query: search || undefined, status: statusFilter || undefined,
    type: typeFilter || undefined, priority: priorityFilter || undefined,
    component: componentFilter || undefined, limit: 25, offset,
  });
  $effect(() => { search; statusFilter; typeFilter; priorityFilter; componentFilter; offset = 0; });
  const stateQuery = createQuery({ queryKey: feedbackKeys.state, queryFn: feedbackApi.state });
  const listQuery = createQuery(reactiveOptions(() => ({
    queryKey: feedbackKeys.list(filters), queryFn: () => feedbackApi.list(filters), refetchInterval: 30000,
  })));
  const detailQuery = createQuery(reactiveOptions(() => ({
    queryKey: feedbackKeys.detail(selected), queryFn: () => feedbackApi.get(selected), enabled: Boolean(selected), refetchInterval: 30000,
  })));
  const item = $derived($detailQuery.data?.feedback);
  const enabled = $derived($stateQuery.data?.enabled ?? false);
  const refresh = () => qc.invalidateQueries({ queryKey: feedbackKeys.all });
  const stateMutation = createMutation({ mutationFn: feedbackApi.setEnabled,
    onSuccess: () => { void refresh(); void qc.invalidateQueries({ queryKey: ['agents'] }); toast.success('Feedback setting saved; agent instructions update on the next sync'); },
    onError: (e: Error) => toast.error(e.message),
  });

  let newTitle = $state('');
  let newDescription = $state('');
  let newType = $state<FeedbackType>('bug');
  let newPriority = $state<FeedbackPriority>('normal');
  let newComponent = $state('other');
  let reproduction = $state('');
  let expected = $state('');
  let actual = $state('');
  let versions = $state('');
  let submitIdentity: { digest: string; id: string } | null = null;
  const submitMutation = createMutation({ mutationFn: feedbackApi.submit,
    onSuccess: ({ feedback }) => {
      selected = feedback.id; statusFilter = ''; createOpen = false;
      newTitle = ''; newDescription = ''; reproduction = ''; expected = ''; actual = ''; versions = ''; submitIdentity = null;
      void refresh(); toast.success('Report submitted');
    }, onError: (e: Error) => toast.error(e.message),
  });
  function submit() {
    const report = { type: newType, title: newTitle, description: newDescription,
      component: newComponent, priority: newPriority,
      ...(reproduction.trim() ? { reproduction } : {}), ...(expected.trim() ? { expected } : {}),
      ...(actual.trim() ? { actual } : {}), ...(versions.trim() ? { versions } : {}),
    };
    const digest = JSON.stringify(report);
    if (!submitIdentity || submitIdentity.digest !== digest) submitIdentity = { digest, id: crypto.randomUUID() };
    $submitMutation.mutate({ ...report, client_request_id: submitIdentity.id });
  }

  let editingId = $state('');
  let draftVersion = $state(0);
  let editTitle = $state('');
  let editType = $state<FeedbackType>('bug');
  let editPriority = $state<FeedbackPriority>('normal');
  let editComponent = $state('');
  let nextStatus = $state('');
  let note = $state('');
  let reason = $state('');
  let resolution = $state('');
  let fixRef = $state('');
  let verification = $state('');
  let duplicateOf = $state('');
  let deployment = $state('');
  let deploymentRef = $state('');
  function loadVersion(row: FeedbackItem) {
    editingId = row.id; draftVersion = row.version; editTitle = row.title;
    editType = row.type; editPriority = row.priority; editComponent = row.component;
  }
  $effect(() => {
    if (item && item.id !== editingId) {
      loadVersion(item); nextStatus = ''; note = ''; reason = ''; resolution = '';
      fixRef = ''; verification = ''; duplicateOf = ''; deployment = ''; deploymentRef = '';
    }
  });
  const updateMutation = createMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => feedbackApi.update(id, body),
    onSuccess: ({ feedback }) => { loadVersion(feedback); nextStatus = ''; note = ''; reason = ''; deployment = ''; deploymentRef = ''; void refresh(); toast.success('Report updated'); },
    onError: (e: Error) => { toast.error(e.message); void refresh(); },
  });
  function update() {
    if (!item) return;
    const body: Record<string, unknown> = { expected_version: draftVersion,
      title: editTitle, type: editType, priority: editPriority, component: editComponent };
    if (nextStatus) body.status = nextStatus;
    if (note.trim()) body.note = note;
    if (reason.trim() && (nextStatus === 'blocked' || nextStatus === 'dismissed')) body.reason = reason;
    if (nextStatus === 'resolved') Object.assign(body, { resolution, fix_ref: fixRef, verification });
    if (nextStatus === 'duplicate') body.duplicate_of = duplicateOf;
    if (deployment) body.deployment = deployment;
    if (deploymentRef.trim()) body.deployment_ref = deploymentRef;
    $updateMutation.mutate({ id: item.id, body });
  }
  const releaseMutation = createMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => feedbackApi.forceRelease(id, reason),
    onSuccess: ({ feedback }) => { loadVersion(feedback); reason = ''; void refresh(); toast.success('Claim released; previous token is invalid'); },
    onError: (e: Error) => toast.error(e.message),
  });
  function actorLabel(actor: Record<string, unknown> | null) {
    if (!actor) return 'Unassigned';
    if (actor.kind === 'system') return 'System';
    if (actor.admin_user_id != null) return `Admin ${actor.admin_user_id}`;
    return `${actor.engine ?? 'Agent'} · Host ${actor.host_id ?? '?'}${actor.agent_uuid ? ` · ${actor.agent_uuid}` : ''}`;
  }
</script>

<svelte:head><title>Feedback · Codex Orchestrator</title></svelte:head>
<PageHeader title="Feedback" eyebrow="Coordinate" subtitle="Orchestrator bugs, missing features and verified improvements">
  {#snippet actions()}<Button variant="outline" onclick={() => { void refresh(); }}>Refresh</Button><Button disabled={!canManage} onclick={() => createOpen = !createOpen}>New report</Button>{/snippet}
</PageHeader>
{#if $stateQuery.isError}<p role="alert" class="mb-4 text-destructive">{$stateQuery.error.message}</p>{/if}
<ModuleSwitchRow id="feedback-enabled" label="Agent feedback" checked={enabled}
  description={enabled ? 'Agents can report and claim work. AGENTS.md, CLAUDE.md and Grok instructions include the workflow.' : 'Agent tools and managed instructions are disabled. Retained reports remain available here.'}
  disabled={!canManage || $stateMutation.isPending || $stateQuery.isPending}
  onCheckedChange={(value) => $stateMutation.mutate(value)} />

{#if createOpen}
  <form class="my-6 grid gap-4 rounded-lg border bg-card p-5 md:grid-cols-2" onsubmit={(e) => { e.preventDefault(); submit(); }}>
    <h2 class="font-semibold md:col-span-2">New report</h2>
    <label class="text-sm">Title<input class={control} bind:value={newTitle} required maxlength="255" /></label>
    <label class="text-sm">Component<input class={control} bind:value={newComponent} required maxlength="100" placeholder="MCP, wrapper, WebUI…" /></label>
    <label class="text-sm">Type<select class={control} bind:value={newType}>{#each feedbackTypes as value}<option>{value}</option>{/each}</select></label>
    <label class="text-sm">Priority<select class={control} bind:value={newPriority}>{#each feedbackPriorities as value}<option>{value}</option>{/each}</select></label>
    <label class="text-sm md:col-span-2">Description<textarea class={control} bind:value={newDescription} required maxlength="32000" rows="4"></textarea></label>
    <label class="text-sm md:col-span-2">Reproduction steps<textarea class={control} bind:value={reproduction} maxlength="32000" rows="3"></textarea></label>
    <label class="text-sm">Expected behavior<textarea class={control} bind:value={expected} maxlength="32000"></textarea></label>
    <label class="text-sm">Actual behavior<textarea class={control} bind:value={actual} maxlength="32000"></textarea></label>
    <label class="text-sm md:col-span-2">Versions<input class={control} bind:value={versions} maxlength="1000" /></label>
    <div class="flex gap-2 md:col-span-2"><Button type="submit" disabled={$submitMutation.isPending || !canManage}>Submit report</Button><Button variant="outline" onclick={() => createOpen = false}>Cancel</Button></div>
  </form>
{/if}

<div class="my-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
  <label class="text-xs text-muted-foreground">Search<input class={control} bind:value={search} placeholder="Title or description" /></label>
  <label class="text-xs text-muted-foreground">Status<select aria-label="Filter status" class={control} bind:value={statusFilter}><option value="">All statuses</option>{#each feedbackStatuses as value}<option>{value}</option>{/each}</select></label>
  <label class="text-xs text-muted-foreground">Type<select class={control} bind:value={typeFilter}><option value="">All types</option>{#each feedbackTypes as value}<option>{value}</option>{/each}</select></label>
  <label class="text-xs text-muted-foreground">Priority<select class={control} bind:value={priorityFilter}><option value="">All priorities</option>{#each feedbackPriorities as value}<option>{value}</option>{/each}</select></label>
  <label class="text-xs text-muted-foreground">Component<input class={control} bind:value={componentFilter} placeholder="All components" /></label>
</div>
<div class="grid items-start gap-5 xl:grid-cols-[minmax(280px,1fr)_minmax(400px,1.5fr)]">
  <section aria-label="Feedback inbox" class="min-w-0 rounded-lg border bg-card">
    {#if $listQuery.isPending}<p class="p-5 text-muted-foreground">Loading reports…</p>
    {:else if $listQuery.isError}<p role="alert" class="p-5 text-destructive">{$listQuery.error.message}</p>
    {:else if !$listQuery.data?.feedback.length}<p class="p-8 text-center text-muted-foreground">No reports match these filters.</p>
    {:else}
      {#each $listQuery.data.feedback as row (row.id)}
        <button class="block w-full border-b p-4 text-left transition-colors hover:bg-muted/50" class:bg-muted={selected === row.id} onclick={() => selected = row.id} aria-pressed={selected === row.id}>
          <div class="mb-1 flex flex-wrap gap-2 text-xs text-muted-foreground"><span class:text-destructive={row.priority === 'critical'}>{row.priority}</span><span>{row.type}</span><span>{row.status.replace('_', ' ')}</span></div>
          <p class="break-words font-medium">{row.title}</p>
          <p class="mt-1 text-xs text-muted-foreground">{row.component} · {relativeTime(row.updated_at)}</p>
          {#if row.claim_owner}<p class="mt-1 break-words text-xs">{actorLabel(row.claim_owner)}</p>{/if}
        </button>
      {/each}
    {/if}
    <div class="flex items-center justify-between p-3"><Button variant="outline" size="sm" disabled={offset === 0} onclick={() => offset = Math.max(0, offset - 25)}>Previous</Button><span class="text-xs">Page {Math.floor(offset / 25) + 1}</span><Button variant="outline" size="sm" disabled={$listQuery.data?.next_offset == null} onclick={() => offset = $listQuery.data?.next_offset ?? offset}>Next</Button></div>
  </section>
  <section aria-label="Report details" class="min-w-0 rounded-lg border bg-card p-5">
    {#if !selected}<p class="py-12 text-center text-muted-foreground">Select a report to inspect evidence and progress.</p>
    {:else if $detailQuery.isError}<p role="alert" class="text-destructive">{$detailQuery.error.message}</p>
    {:else if !item}<p class="text-muted-foreground">Loading report…</p>
    {:else}
      <h2 class="break-words text-xl font-semibold">{item.title}</h2>
      <p class="mt-1 break-all font-mono text-xs text-muted-foreground">{item.id}</p>
      <p class="mt-3 text-sm">{item.status.replace('_', ' ')} · {actorLabel(item.claim_owner)}</p>
      {#if item.claim_expires_at}<p class="text-xs text-muted-foreground">Claim expires {new Date(item.claim_expires_at).toLocaleString()}</p>{/if}
      <p class="mt-2 text-sm">Deployment: {item.deployment.replace('_', ' ')}{item.deployment_ref ? ` · ${item.deployment_ref}` : ''}</p>
      {#if item.duplicate_of}<p class="break-all text-sm">Duplicate of {item.duplicate_of}</p>{/if}
      <p class="mt-2 break-words text-xs text-muted-foreground">Reported by {actorLabel(item.source)}</p>
      <div class="my-5 space-y-3 border-y py-4">
        <h3 class="text-sm font-semibold">Original report</h3>
        {#each Object.entries(item.report ?? {}) as [key, value]}
          <div><h4 class="text-xs font-medium uppercase text-muted-foreground">{key}</h4><p class="whitespace-pre-wrap break-words text-sm">{value}</p></div>
        {/each}
      </div>
      {#if item.result}<div class="mb-5 space-y-3"><h3 class="text-sm font-semibold">Outcome</h3>{#each Object.entries(item.result) as [key, value]}{#if value}<p class="whitespace-pre-wrap break-words text-sm"><strong>{key}:</strong> {value}</p>{/if}{/each}</div>{/if}
      {#if canManage}
        <form class="grid gap-3 sm:grid-cols-2" onsubmit={(e) => { e.preventDefault(); update(); }}>
          <h3 class="font-semibold sm:col-span-2">Triage and outcome</h3>
          {#if item.version !== draftVersion}<div role="alert" class="rounded border border-amber-500 p-3 text-sm sm:col-span-2">This report changed while you were editing. Your draft is retained. <Button variant="outline" size="sm" onclick={() => item && loadVersion(item)}>Load current version</Button></div>{/if}
          <label class="text-sm">Title<input class={control} bind:value={editTitle} required maxlength="255" /></label>
          <label class="text-sm">Component<input class={control} bind:value={editComponent} required maxlength="100" /></label>
          <label class="text-sm">Type<select class={control} bind:value={editType}>{#each feedbackTypes as value}<option>{value}</option>{/each}</select></label>
          <label class="text-sm">Priority<select class={control} bind:value={editPriority}>{#each feedbackPriorities as value}<option>{value}</option>{/each}</select></label>
          <label class="text-sm sm:col-span-2">Status<select aria-label="Report status" class={control} bind:value={nextStatus}><option value="">Keep current status</option>{#each feedbackStatuses.filter((s) => s !== 'in_progress') as value}<option>{value}</option>{/each}</select></label>
          <label class="text-sm sm:col-span-2">Add evidence or comment<textarea class={control} bind:value={note} maxlength="32000" rows="3"></textarea></label>
          {#if nextStatus === 'blocked' || nextStatus === 'dismissed'}<label class="text-sm sm:col-span-2">Reason<input class={control} bind:value={reason} required maxlength="1000" /></label>{/if}
          {#if nextStatus === 'resolved'}
            <p class="text-xs text-muted-foreground sm:col-span-2">Resolved means a verified fix. Production deployment is recorded separately.</p>
            <label class="text-sm sm:col-span-2">Resolution<textarea class={control} bind:value={resolution} required maxlength="32000"></textarea></label>
            <label class="text-sm sm:col-span-2">Fix reference<input class={control} bind:value={fixRef} required maxlength="1000" placeholder="Commit, PR or durable patch reference" /></label>
            <label class="text-sm sm:col-span-2">Verification<textarea class={control} bind:value={verification} required maxlength="32000" placeholder="Checks performed and their results"></textarea></label>
          {/if}
          {#if nextStatus === 'duplicate'}<label class="text-sm sm:col-span-2">Canonical report ID<input class={control} bind:value={duplicateOf} required /></label>{/if}
          <label class="text-sm">Deployment<select aria-label="Deployment" class={control} bind:value={deployment}><option value="">Keep current deployment</option><option value="unknown">Unknown</option><option value="not_deployed">Not deployed</option><option value="deployed">Deployed</option></select></label>
          <label class="text-sm">Deployment reference<input class={control} bind:value={deploymentRef} required={deployment === 'deployed'} maxlength="1000" /></label>
          <div class="sm:col-span-2"><Button type="submit" disabled={$updateMutation.isPending || draftVersion !== item.version}>Save update</Button></div>
        </form>
        {#if item.claim_owner}<form class="mt-5 flex flex-wrap gap-2 border-t pt-4" onsubmit={(e) => { e.preventDefault(); if (item) $releaseMutation.mutate({ id: item.id, reason }); }}><label class="min-w-0 flex-1 text-sm">Release reason<input class={control} bind:value={reason} required maxlength="1000" /></label><Button type="submit" variant="outline" disabled={$releaseMutation.isPending}>Force release</Button></form>{/if}
      {/if}
      <div class="mt-6 border-t pt-4"><h3 class="mb-3 font-semibold">History</h3>{#each $detailQuery.data?.events ?? [] as event (event.id)}<details class="mb-2 rounded border p-3"><summary class="cursor-pointer text-sm">v{event.version} · {event.action.replaceAll('_', ' ')} · {actorLabel(event.actor)}<span class="ml-2 text-xs text-muted-foreground">{relativeTime(event.created_at)}</span></summary><pre class="mt-3 whitespace-pre-wrap break-all text-xs">{JSON.stringify(event.detail, null, 2)}</pre></details>{/each}</div>
    {/if}
  </section>
</div>
