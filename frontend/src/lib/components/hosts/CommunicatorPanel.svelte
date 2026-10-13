<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { api } from '$lib/api/client';
  let { id }: { id: string | number } = $props();
  interface Connection { host_id: number; username: string; version: string; sessions: number; requests: number; connected_at: string; synced_at: string | null }
  const query = createQuery({
    queryKey: ['communicators'],
    queryFn: () => api.get<{ enabled: boolean; connections: Connection[] }>('/admin/communicators'),
    refetchInterval: 30000,
  });
  const connections = $derived(($query.data?.connections ?? []).filter(c => c.host_id === Number(id)));
</script>
<section class="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="communicator-heading">
  <h2 id="communicator-heading" class="text-sm font-semibold">CoCo Communicator</h2>
  <p class="text-xs text-muted-foreground">Shares one server connection across this user's Codex, Claude and Grok sessions. Starts automatically and stops after five idle minutes; an enabled host daemon keeps it running.</p>
  {#if $query.error}<p role="alert" class="text-sm text-destructive">{$query.error.message}</p>
  {:else if $query.isPending}<p class="text-sm text-muted-foreground">Loading connection status…</p>
  {:else if !$query.data?.enabled}<p class="text-sm text-muted-foreground">Shared transport is disabled on the server.</p>
  {:else if connections.length === 0}<p class="text-sm text-muted-foreground">No communicator connected. Requires cxx 0.9.71 or newer.</p>
  {:else}
    {#each connections as connection}
      <div class="text-sm"><strong>{connection.username}</strong> · cxx {connection.version} · {connection.sessions} clients · {connection.requests} requests
        <p class="text-xs text-muted-foreground">Connected {new Date(connection.connected_at).toLocaleString()} · Last sync: {connection.synced_at ? new Date(connection.synced_at).toLocaleString() : 'Pending'}</p>
      </div>
    {/each}
  {/if}
</section>
