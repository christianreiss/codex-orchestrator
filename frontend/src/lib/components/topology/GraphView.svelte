<script lang="ts">
  /** The Graph view: the connection tree as a radial map or a list, with the conversation drawer beside it. */
  import { Button } from "$lib/components/ui/button";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { StateBlock } from "$lib/components/page";
  import ClientsWorkspace from "$lib/components/portal/ClientsWorkspace.svelte";
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { coordinationQuery } from '$lib/api/coordination';
  import { api } from '$lib/api/client';
  import { authStore } from '$lib/stores/auth';
  import { scopeGroups } from '$lib/topology/scope-groups';
  import ScopeChat from './ScopeChat.svelte';
  import TopologyGraph from "./TopologyGraph.svelte";
  import TopologyList from "./TopologyList.svelte";
  import type { AgentsView } from "./agents-view.svelte";

  let { agents }: { agents: AgentsView } = $props();
  const scopes = coordinationQuery();
  const queryClient = useQueryClient();
  let roomId = $state<string | null>(null);
  $effect(() => { if (agents.chatOpen) roomId = null; });
  const room = $derived($scopes.data?.rooms.find(r => r.id === roomId));
  const enableScopes = createMutation({ mutationFn: () => api.post('/admin/agent-messaging/scopes/state', { enabled: true }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-scopes'] }) });
  const groups = $derived(agents.grouping === 'connection' || !$scopes.data?.enabled ? [] : (agents.grouping === 'scopes' ? ['project', 'host'] as const : [agents.grouping]).flatMap(kind => scopeGroups(agents.visibleModel.agents.map(a => a.node), $scopes.data!.rooms, $scopes.data!.claims, kind)).filter(g => g.room));
  const palette = ['hsl(var(--primary))', 'hsl(var(--persona-claude))', 'hsl(var(--success))', 'hsl(var(--warning))', 'hsl(var(--muted-foreground))'];
  const clouds = $derived(groups.map((group, i) => ({ id: group.id, title: group.title, color: palette[i % palette.length], members: group.agents.map(a => a.id) })));
  const topology = $derived(agents.topology.current);
  const stale = $derived(topology.isError && Boolean(topology.data));
  const updated = $derived(topology.data ? new Date(topology.data.generated_at).toLocaleTimeString() : "—");
</script>

{#if topology.isError && !topology.data}
  <StateBlock state="error" message={`The topology could not be loaded. ${topology.error.message}`} onRetry={() => topology.refetch()} />
{:else if topology.isPending}
  <Skeleton class="h-[60vh] w-full" />
{:else}
  <p class="text-caption text-muted-foreground" aria-live="polite">
    {#if stale}<span class="text-warning">Showing the last good snapshot. </span>{/if}Updated {updated}
    {#if topology.data && !topology.data.server.communicator_enabled}
      · The connection (communicator) transport is off on this server, so every session connects directly.
    {/if}
  </p>

  <div class="my-2 flex flex-wrap items-center gap-2">
    <label for="scope-grouping" class="text-caption">Group clouds</label>
    <select id="scope-grouping" class="rounded border bg-background px-2 py-1" bind:value={agents.grouping}>
      <option value="connection">None</option><option value="project">Project</option><option value="host">Host</option><option value="scopes">Project + Host</option>
    </select>
    {#if $scopes.data && !$scopes.data.enabled}{#if $authStore.can('agent_messaging.manage')}<Button size="sm" variant="outline" disabled={$enableScopes.isPending} onclick={() => $enableScopes.mutate()}>Enable project rooms</Button>{/if}{/if}
    {#if $scopes.error}<span role="alert" class="text-destructive">{$scopes.error.message}</span>{/if}
    {#if $enableScopes.error}<span role="alert" class="text-destructive">{$enableScopes.error.message}</span>{/if}
  </div>
  {#if groups.length}
    <div class="mb-2 flex flex-wrap gap-2" aria-label="Scope groups">
      {#each groups as group, i (group.id)}
        <Button size="sm" variant="outline" onclick={() => { roomId = group.id; agents.chatOpen = false; }} aria-label={`Open ${group.title} chat`}><span class="h-2 w-2 rounded-full" style:background={palette[i % palette.length]}></span>{group.title} · {group.agents.length}</Button>
      {/each}
    </div>
  {/if}
  <div class={agents.fullscreen ? "fixed inset-0 z-40 flex flex-col gap-2 bg-background p-4" : "flex min-h-0 flex-col"}>
    {#if agents.fullscreen}
      <div class="flex justify-end"><Button size="sm" variant="outline" onclick={() => (agents.fullscreen = false)}>Exit fullscreen</Button></div>
    {/if}
    <div class="relative min-h-0 flex-1 {(agents.chatOpen || room) ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,40%)] lg:gap-3' : ''}">
      <div class="relative min-w-0">
        <div class={agents.fullscreen ? "h-[calc(100dvh-6rem)] min-w-0" : "h-[62vh] min-h-[24rem] min-w-0 lg:h-[calc(100dvh-22rem)]"}>
          {#if agents.layout === "radial"}
            <TopologyGraph {clouds} bind:this={agents.graph} server={topology.data?.server} model={agents.visibleModel} selectedId={agents.selectedId} query={agents.search} onselect={(id) => agents.select(id)} />
          {:else}
            <div class="h-full overflow-y-auto pr-1">
              <TopologyList model={agents.visibleModel} selectedId={agents.selectedId} query={agents.search} onselect={(id) => agents.select(id)} />
            </div>
          {/if}
        </div>
      </div>
      {#if room}<aside class="absolute inset-0 z-10 min-h-0 bg-card lg:static" aria-label="Scope conversation">{#key room.id}<ScopeChat {room} claims={$scopes.data?.claims ?? []} onclose={() => { roomId = null; }} />{/key}</aside>{/if}
      <aside class={agents.chatOpen ? "absolute inset-0 z-10 flex min-h-0 flex-col rounded-md border bg-card lg:static" : "hidden"} aria-label="Topology conversation">
        <div class="flex items-center justify-between border-b p-2">
          <span class="text-body font-medium">Conversation</span>
          <Button size="sm" variant="ghost" onclick={() => (agents.chatOpen = false)}>Close chat</Button>
        </div>
        {#if agents.chatId || agents.spawnOpen || agents.chatOpen}
          <ClientsWorkspace embedded sessionId={agents.chatId} spawnHost={agents.spawnHost} bind:spawnOpen={agents.spawnOpen} />
        {/if}
      </aside>
    </div>
  </div>
{/if}
