<script lang="ts">
  import { ENGINES, ENGINE_META } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";

  let { engines }: { engines: string[] } = $props();
  const fleet = useFleetEngines();
</script>

<span class="inline-flex items-center gap-3">
  {#each ENGINES as engine}
    {@const assigned = engines.includes(engine)}
    {@const suspended = !$fleet.isEnabled(engine)}
    {@const enabled = assigned && !suspended}
    {@const label = `${ENGINE_META[engine].label}: ${enabled ? "enabled" : assigned && suspended ? "disabled fleet-wide" : "not assigned"}`}
    <span class="inline-flex h-4 w-4 items-center justify-center" role="img" aria-label={label} title={label}>
      <span class={`h-2 w-2 rounded-full ${enabled ? "bg-green-500" : "bg-red-500"}`} aria-hidden="true"></span>
    </span>
  {/each}
</span>
