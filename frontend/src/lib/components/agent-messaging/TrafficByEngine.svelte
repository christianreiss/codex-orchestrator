<script lang="ts">
  /** Recorded delivery counts per engine pair (the former "direction matrix"), collapsed by default. */
  import type { AgentMessagingState } from "$lib/api/agentMessaging";
  import { engineLabel, isEngine } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";

  let { traffic }: { traffic: AgentMessagingState | undefined } = $props();
  const fleet = useFleetEngines();
  // A lane that touches a switched-off engine is kept server-side and not listed here.
  const directions = $derived([...(traffic?.directions ?? []), ...(traffic?.server_directions ?? [])].filter((lane) => $fleet.isEnabled(lane.source_engine) && $fleet.isEnabled(lane.target_engine)));
  const peer = (value: string) => (isEngine(value) ? engineLabel(value) : value === "server" ? "Server" : value);
  const outcome = (source: string, target: string) => (source === "server" ? "accepted" : target === "server" ? "responses" : "completed");
</script>

<details class="group rounded-md border px-3 py-2">
  <summary class="cursor-pointer select-none text-body font-medium">
    Traffic by engine <span class="ml-2 text-body-sm font-normal text-muted-foreground">Recorded deliveries between engines and the server (direction matrix)</span>
  </summary>
  <p class="mt-2 text-body-sm text-muted-foreground">Engine deliveries share the same ordered at-least-once contract. Server lanes count operator delivery and native session event receipts.</p>
  {#if directions.length === 0}
    <p class="mt-2 text-body-sm text-muted-foreground">No traffic recorded yet.</p>
  {:else}
    <div class="mt-3 grid divide-y border-y md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-3">
      {#each directions as direction (`${direction.source_engine}-${direction.target_engine}`)}
        <div class="px-3 py-2">
          <p class="text-body font-medium">{peer(direction.source_engine)} → {peer(direction.target_engine)}</p>
          <p class="text-caption text-muted-foreground">
            {direction.total} total · {direction.pending} pending · {direction.completed} {outcome(direction.source_engine, direction.target_engine)}
          </p>
          {#if direction.dead || direction.ambiguous}
            <p class="text-caption text-destructive">{direction.dead} dead · {direction.ambiguous} ambiguous</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</details>
