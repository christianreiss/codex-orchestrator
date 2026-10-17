<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { api } from '$lib/api/client';
  let { id }: { id: string | number } = $props();
  interface Scope { scope: string; running: boolean; content_error: string; auth: {engine: string; account_id?: number; state: string; native_adoption: string; error?: string; updated_at?: string} }
  interface Connection { sync_scopes?: Scope[]; host_id: number; username: string; version: string; sessions: number; requests: number; connected_at: string; synced_at: string | null }
  const query = createQuery({
    queryKey: ['communicators'],
    queryFn: () => api.get<{ enabled: boolean; connections: Connection[] }>('/admin/communicators'),
    refetchInterval: 30000,
  });
  const authLabels: Record<string, string> = {pending:'Waiting for first sync', checked:'Credentials checked', server_confirmed:'Upload confirmed', locally_written:'Credentials written locally', deferred:'Waiting for local credential change', error:'Sync needs attention'};
  const connections = $derived(($query.data?.connections ?? []).filter(c => c.host_id === Number(id)));
</script>
<section class="space-y-2" aria-labelledby="communicator-heading">
  <h3 id="communicator-heading" class="text-h3">Connection <span class="text-body-sm font-normal text-muted-foreground">CoCo communicator</span></h3>
  <p class="text-body-sm text-muted-foreground">Shares one server connection across this user's Codex, Claude and Grok sessions. Coordinates live content and credential updates without restarting native sessions. An enabled host daemon keeps it running.</p>
  {#if $query.error}<p role="alert" class="text-body text-destructive">{$query.error.message}</p>
  {:else if $query.isPending}<p class="text-body text-muted-foreground">Loading connection status…</p>
  {:else if !$query.data?.enabled}<p class="text-body text-muted-foreground">Shared transport is disabled on the server.</p>
  {:else if connections.length === 0}<p class="text-body text-muted-foreground">No communicator connected. Requires cxx 0.9.71 or newer.</p>
  {:else}
    {#each connections as connection}
      <div class="text-body"><strong>{connection.username}</strong> · cxx {connection.version} · {connection.sessions} clients · {connection.requests} requests
        <p class="text-body-sm text-muted-foreground">Connected {new Date(connection.connected_at).toLocaleString()} · Last sync: {connection.synced_at ? new Date(connection.synced_at).toLocaleString() : 'Pending'}</p>
        {#each connection.sync_scopes ?? [] as scope (scope.scope)}
          <p class="mt-1 text-body-sm text-muted-foreground">
            {scope.auth.engine}{scope.auth.account_id ? ` · Account ${scope.auth.account_id}` : ''} · {scope.running ? 'Synchronizing' : (authLabels[scope.auth.state] ?? 'Waiting for sync')}
            {#if scope.auth.native_adoption === 'pending' || scope.auth.native_adoption === 'unconfirmed'} · Written locally; native process has not confirmed adoption{/if}
          </p>
          {#if scope.content_error || scope.auth.error}<p class="text-body-sm text-destructive">{scope.content_error || scope.auth.error}</p>{/if}
        {/each}
      </div>
    {/each}
  {/if}
</section>
