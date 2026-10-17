<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Settings from "@lucide/svelte/icons/settings";
  import { page } from "$app/state";
  import { PageShell, StatStrip } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import AddressesView from "$lib/components/agent-messaging/AddressesView.svelte";
  import Conferences from "$lib/components/agent-messaging/Conferences.svelte";
  import ConversationsView from "$lib/components/agent-messaging/ConversationsView.svelte";
  import DeliveryLog from "$lib/components/agent-messaging/DeliveryLog.svelte";
  import Groups from "$lib/components/agent-messaging/Groups.svelte";
  import MessagingToolbar from "$lib/components/agent-messaging/MessagingToolbar.svelte";
  import ServiceNotes from "$lib/components/agent-messaging/ServiceNotes.svelte";
  import TrafficByEngine from "$lib/components/agent-messaging/TrafficByEngine.svelte";
  import { createMessagingFilters } from "$lib/components/agent-messaging/messaging-filters.svelte";
  import { createServiceToggle } from "$lib/components/agent-messaging/service-toggle.svelte";
  import AgentMessagingConfirmDialog from "$lib/components/settings/AgentMessagingConfirmDialog.svelte";
  import { agentMessagingKeys } from "$lib/api/agentMessaging";

  const filters = createMessagingFilters();
  const service = createServiceToggle();
  const queryClient = useQueryClient();

  let settingsOpen = $state(page.url.hash === "#service-state");
  const snapshot = $derived(service.state);
  const enabled = $derived(snapshot?.enabled ?? false);
  const pending = $derived((snapshot?.messages.queued ?? 0) + (snapshot?.messages.leased ?? 0) + (snapshot?.messages.accepted ?? 0));
  const stats = $derived([
    { label: "addresses", value: snapshot?.addresses ?? 0 },
    { label: "live", value: snapshot?.live_addresses ?? 0, tone: "success" as const },
    { label: "relays", value: snapshot?.relays ?? 0 },
    { label: "open conversations", value: snapshot?.open_conversations ?? 0 },
    { label: "pending", value: pending, tone: pending > 0 ? ("warning" as const) : ("default" as const) },
  ]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: agentMessagingKeys.all });
    toast.success("Messages refreshed");
  }
</script>

<PageShell
  title="Messages"
  description="Conversations between Codex, Claude, Grok and Server agents (agent messaging)."
  toggle={{ label: "Enable messages", checked: service.checked, disabled: service.disabled, onChange: (next) => service.request(next) }}
>
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={refresh}><RefreshCw class="h-4 w-4" /> Refresh</Button>
    <Button variant="ghost" size="icon" aria-label="Service settings" aria-expanded={settingsOpen} aria-controls="service-state" title="Service settings" onclick={() => (settingsOpen = !settingsOpen)}>
      <Settings class="h-4 w-4" />
    </Button>
  {/snippet}

  {#if snapshot && !enabled}
    <p role="status" class="rounded-md border border-warning/25 bg-warning-muted px-3 py-2 text-body-sm text-warning-muted-foreground">
      Messages are off. Discovery, send, reply, wake, resume and relay polling are blocked; retained metadata and audit history stay readable.
    </p>
  {/if}

  {#if settingsOpen}<ServiceNotes {enabled} />{/if}

  <StatStrip items={stats} />

  <MessagingToolbar model={filters} />

  {#if filters.view === "conversations"}
    <ConversationsView {filters} />
  {:else if filters.view === "addresses"}
    <AddressesView />
  {:else if filters.view === "groups"}
    <Groups {enabled} />
  {:else if filters.view === "conferences"}
    <Conferences limit={filters.limit} />
  {:else}
    <DeliveryLog {filters} {enabled} />
  {/if}

  <TrafficByEngine traffic={snapshot} />
</PageShell>

<AgentMessagingConfirmDialog {...service.dialog} />
