<script lang="ts">
  /** The one filter row of the Agents page, shared by the Live and Graph views. */
  import { useQueryClient } from "@tanstack/svelte-query";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Plus from "@lucide/svelte/icons/plus";
  import { Toolbar } from "$lib/components/page";
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import { Button } from "$lib/components/ui/button";
  import { authStore } from "$lib/stores/auth";
  import { agentSessionKeys } from "$lib/api/agentSessions";
  import type { AgentsView } from "./agents-view.svelte";

  let { agents }: { agents: AgentsView } = $props();

  const client = useQueryClient();
  const canManage = $derived($authStore.can("agent_messaging.manage"));
  const remote = $derived(agents.view === "live" && agents.workspace === "remote");
  const statuses = $derived([...new Set(agents.model.agents.map((a) => a.node.presence))]);
  const hosts = $derived([...new Map([...agents.model.communicators, ...agents.model.agents].map((a) => [a.node.host_id, a.node.host])).entries()]);
  const count = $derived(
    agents.view === "graph" && agents.topology.current.data
      ? `${agents.visibleModel.agents.length} of ${agents.model.agents.length} agents`
      : undefined,
  );

  function refresh() {
    void client.invalidateQueries({ queryKey: agentSessionKeys.all });
    void client.invalidateQueries({ queryKey: ["host-daemons"] });
    void client.invalidateQueries({ queryKey: ["daemon-sessions"] });
    void agents.topology.current.refetch();
  }
  const selectClass = "h-9 rounded-md border border-input bg-card px-3 text-body-sm";
</script>

{#snippet filters()}
  <SegmentedControl
    label="Agents view"
    value={agents.view}
    onChange={(next) => agents.setView(next === "graph" ? "graph" : "live")}
    options={[
      { value: "live", label: "Chats", hint: "Direct messages, shared rooms and conferences" },
      { value: "graph", label: "Graph", hint: "How agents connect to the server (topology)" },
    ]}
  />
  {#if agents.view === "live" && canManage}
    <SegmentedControl
      label="Client workspace"
      value={agents.workspace}
      onChange={(next) => { agents.workspace = next === "remote" ? "remote" : "agents"; agents.liveSelectedId = null; }}
      options={[{ value: "agents", label: "Agents" }, { value: "remote", label: "Remote sessions", hint: "Sessions launched by a host daemon" }]}
    />
  {/if}
  {#if !remote}
    <select aria-label="Engine" id="client-engine" bind:value={agents.engine} class={selectClass}>
      <option value="all">All engines</option>
      <option value="codex">Codex</option>
      <option value="claude">Claude</option>
      <option value="grok">Grok</option>
    </select>
  {/if}
  {#if agents.view === "graph"}
    <select aria-label="Filter status" bind:value={agents.status} class={selectClass}>
      <option value="all">All statuses</option>
      {#each statuses as status (status)}<option value={status}>{status}</option>{/each}
    </select>
    <select aria-label="Filter host" bind:value={agents.host} class={selectClass}>
      <option value="all">All hosts</option>
      {#each hosts as [id, host] (id)}<option value={String(id)}>{host}</option>{/each}
    </select>
    <select aria-label="Filter runtime" bind:value={agents.mode} class={selectClass}>
      <option value="all">All runtimes</option>
      <option value="resident">Persistent</option>
      <option value="on_demand">On demand</option>
      <option value="unknown">Unknown</option>
    </select>
    <SegmentedControl
      label="View"
      value={agents.layout}
      onChange={(next) => (agents.layout = next === "list" ? "list" : "radial")}
      options={[{ value: "radial", label: "Radial" }, { value: "list", label: "List" }]}
    />
  {/if}
  {#if agents.view === "graph" && agents.filtersActive}
    <Button size="sm" variant="ghost" onclick={() => agents.resetFilters()}>Reset filters</Button>
  {/if}
{/snippet}

{#snippet actions()}
  {#if agents.view === "graph"}
    <Button size="sm" variant="ghost" disabled={!agents.selectedId} onclick={() => agents.graph?.centerSelection()}>Center selection</Button>
    {#if !agents.fullscreen}<Button size="sm" variant="ghost" onclick={() => (agents.fullscreen = true)}>Fullscreen</Button>{/if}
  {/if}
  {#if agents.view === "graph" || remote}<Button size="sm" variant="outline" aria-label="Refresh agents" disabled={agents.topology.current.isFetching} onclick={refresh}>
    <RefreshCw class="h-4 w-4 {agents.topology.current.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}" /> Refresh
  </Button>{/if}
  {#if agents.view === "graph"}
    <Button disabled={!canManage} onclick={() => agents.startAgent()}><Plus class="h-4 w-4" /> Start agent</Button>
  {:else if canManage}
    <Button variant={remote ? "default" : "outline"} size="sm" onclick={() => { agents.workspace = "remote"; agents.startRemote = true; }}><Plus class="h-4 w-4" /> Start remote session</Button>
  {/if}
{/snippet}

{#if remote}
  <Toolbar {filters} {actions} {count} />
{:else}
  <Toolbar
    bind:search={agents.search}
    searchPlaceholder={agents.view === "graph" ? "Find a node" : "Find a client"}
    {filters}
    {actions}
    {count}
  />
{/if}
