<script lang="ts">
  /**
   * Everything that is rarely touched, collapsed by default. It opens by itself when
   * the host carries per-host exceptions, so an unusual setup is never hidden.
   */
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import type { HostDetailResponse } from "$lib/api/types";
  import CommunicatorPanel from "../CommunicatorPanel.svelte";
  import DaemonPanel from "../DaemonPanel.svelte";
  import HostExceptions from "./HostExceptions.svelte";
  import HostIntegrations from "./HostIntegrations.svelte";
  import NetworkSettings from "./NetworkSettings.svelte";

  type Props = { data: HostDetailResponse; id: string };
  let { data, id }: Props = $props();
  const host = $derived(data.host);

  const exceptions = $derived(
    [
      host.model_override, host.reasoning_effort_override, host.client_version_override,
      host.claude_model_override, host.claude_client_version_override,
      host.grok_model_override, host.grok_reasoning_effort_override, host.grok_client_version_override,
      host.agents_document_id_override,
    ].filter((value) => value != null && value !== "").length,
  );

  // Open once per host if it has exceptions; after that the operator's toggle wins.
  let open = $state(false);
  let seeded: string | null = null;
  $effect(() => {
    if (seeded !== id) {
      seeded = id;
      open = exceptions > 0;
    }
  });
</script>

<details bind:open class="group border-t pt-3" data-testid="host-advanced">
  <summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-h3 [&::-webkit-details-marker]:hidden">
    <ChevronRight class="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
    Network, overrides and remote sessions
    <span class="text-body-sm font-normal text-muted-foreground">
      Network, per-host exceptions{exceptions ? ` (${exceptions} set)` : ""}, integrations, remote sessions
    </span>
  </summary>
  <div class="mt-4 flex flex-col gap-8">
    <NetworkSettings {host} {id} />
    <HostExceptions {host} overview={data.overview} {id} />
    <HostIntegrations {host} {id} />
    {#key id}
      <DaemonPanel {id} />
      <CommunicatorPanel {id} />
    {/key}
  </div>
</details>
