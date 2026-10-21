<script lang="ts">
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { coordinationStateKey, coordinationStateQuery, writeCoordinationState } from '$lib/api/coordination';
  import { authStore } from '$lib/stores/auth';
  import { Section, SaveState, StateBlock } from '$lib/components/page';
  import { Switch } from '$lib/components/ui/switch';
  import { Button } from '$lib/components/ui/button';

  const canRead = $derived($authStore.can('agent_messaging.read'));
  const canManage = $derived($authStore.can('agent_messaging.manage'));
  const query = coordinationStateQuery();
  const client = useQueryClient();
  let attempted = $state<boolean | null>(null);
  let saveError = $state<unknown>(null);
  let checking = $state(false);
  let saved = $state(false);
  let recovered = $state(false);
  const mutation = createMutation({ mutationFn: writeCoordinationState, retry: false });
  const pending = $derived($mutation.isPending || checking);

  function confirm() {
    attempted = null; saveError = null; saved = true;
    void client.invalidateQueries({ queryKey: ['agent-scopes'] });
    void client.invalidateQueries({ queryKey: ['topology'] });
  }
  async function reconcile(retry = false) {
    checking = true;
    try {
      const result = await $query.refetch({ throwOnError: true });
      if (attempted !== null && result.data?.enabled === attempted) {
        recovered = true; confirm();
      } else if (retry && attempted !== null && canManage) {
        const enabled = attempted;
        checking = false;
        await save(enabled);
      }
    } catch {
      // Keep the original save error and requested value until a read confirms state.
    } finally { checking = false; }
  }
  async function save(enabled: boolean) {
    if (!canManage || pending) return;
    attempted = enabled; saveError = null; saved = false; recovered = false;
    await client.cancelQueries({ queryKey: coordinationStateKey });
    try {
      const state = await $mutation.mutateAsync(enabled);
      client.setQueryData(coordinationStateKey, state);
      if (state.enabled !== enabled) throw new Error('The server returned a different coordination setting.');
      confirm();
    } catch (error) {
      saveError = error;
      await reconcile();
    }
  }
</script>

<Section id="agent-coordination" title="Agent coordination" description="Fleet-wide project and host rooms, with resource claims before agents change shared files, branches or services.">
  {#if !canRead}
    <p class="text-body-sm text-muted-foreground">Viewing this setting requires <code class="font-mono">agent_messaging.read</code>. Ask an administrator for access.</p>
  {:else if $query.isPending}
    <StateBlock state="loading" rows={2} />
  {:else}
    {#if $query.isError}
      <StateBlock state="error" message={$query.data ? 'Could not refresh agent coordination. The displayed state is stale.' : 'Could not load agent coordination.'} onRetry={() => void reconcile()} />
    {/if}
    {#if $query.data}
      <div class="flex items-start justify-between gap-4 border-y py-3">
        <div class="min-w-0 space-y-1">
          <label for="agent-coordination-toggle" class="text-body font-medium">Enable agent coordination</label>
          <p id="agent-coordination-help" class="text-body-sm text-muted-foreground">Applies to Codex, Claude and Grok across all managed hosts. Enables automatic room membership and coordination of resource claims.</p>
          <p class="text-body-sm">{$query.isError ? 'Last confirmed state' : 'Effective state'}: <strong>{$query.data.enabled ? 'Enabled' : 'Disabled'}</strong></p>
        </div>
        {#key `${$mutation.status}:${$query.data.enabled}`}
          <Switch id="agent-coordination-toggle" checked={$query.data.enabled} disabled={!canManage || pending || $query.isError || $query.isFetching || attempted !== null} aria-describedby="agent-coordination-help agent-coordination-status" onCheckedChange={(enabled) => void save(enabled)} />
        {/key}
      </div>
    {/if}
    <div id="agent-coordination-status" class="mt-2 space-y-2">
      <p class="text-body-sm text-muted-foreground">Changes save immediately. Turning this off stops automatic rooms and new resource claims; it does not stop running agents. Resource claims coordinate agents; shell commands are not sandboxed.</p>
      {#if !canManage}<p class="text-body-sm text-muted-foreground">Read only. Changes require <code class="font-mono">agent_messaging.manage</code>.</p>{/if}
      {#if pending}<p role="status" class="text-body-sm text-muted-foreground">{checking ? 'Checking the current server state…' : 'Saving… Waiting for server confirmation.'}</p>
      {:else if saveError}
        <SaveState error={saveError} />
        <p class="text-body-sm">Requested state: {attempted ? 'Enabled' : 'Disabled'}. {$query.isError ? 'Current server state is unconfirmed.' : 'The current server state is shown above.'}</p>
        <Button variant="outline" size="sm" onclick={() => void reconcile(canManage)}>{canManage ? 'Check state and retry' : 'Check current state'}</Button>
      {:else if saved}<SaveState saved />
        {#if recovered}<p class="text-body-sm text-muted-foreground">The save response failed, but a fresh server read confirmed the requested state. No repeat write was needed.</p>{/if}
      {:else if $query.isFetching}<p role="status" class="text-body-sm text-muted-foreground">Refreshing current state…</p>{/if}
    </div>
  {/if}
</Section>
