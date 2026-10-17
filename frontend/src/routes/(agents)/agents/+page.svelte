<script lang="ts">
  import { PageShell, StatStrip } from "$lib/components/page";
  import ClientsWorkspace from "$lib/components/portal/ClientsWorkspace.svelte";
  import AgentInspector from "$lib/components/topology/AgentInspector.svelte";
  import AgentsToolbar from "$lib/components/topology/AgentsToolbar.svelte";
  import GraphView from "$lib/components/topology/GraphView.svelte";
  import { createAgentsView } from "$lib/components/topology/agents-view.svelte";

  const agents = createAgentsView();
  const summary = $derived(agents.summary);
  const stats = $derived([
    { label: "connections", value: summary.communicators, hint: "Connections are communicators" },
    { label: "agents", value: summary.agents },
    { label: "via a connection", value: summary.attributed, tone: "success" as const },
    ...(summary.stale > 0 ? [{ label: "link quiet", value: summary.stale, tone: "warning" as const }] : []),
    { label: "direct", value: summary.unattributed },
  ]);
  // On a phone an open conversation takes the whole screen.
  const conversationOpen = $derived(agents.view === "live" && agents.liveSelectedId !== null);
</script>

<PageShell
  title="Agents"
  description="Who is running, what they are working on, and how each one connects to the server."
  width="wide"
>
  <div class={conversationOpen ? "max-lg:hidden" : ""}>
    <AgentsToolbar {agents} />
  </div>

  <div class="lg:flex lg:items-start lg:gap-4">
    <div class="min-w-0 flex-1 space-y-4">
      {#if agents.view === "graph"}
        <StatStrip items={stats} />
        <GraphView {agents} />
      {:else}
        <ClientsWorkspace
          bind:search={agents.search}
          bind:engine={agents.engine}
          bind:filter={agents.liveFilter}
          bind:workspace={agents.workspace}
          bind:startRemote={agents.startRemote}
          bind:selectedId={agents.liveSelectedId}
          oninspect={(id) => agents.select(id)}
        />
      {/if}
    </div>
    <AgentInspector {agents} />
  </div>
</PageShell>

