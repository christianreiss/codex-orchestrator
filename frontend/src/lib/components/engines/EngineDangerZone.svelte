<script lang="ts">
  /** Last section on /engines: remove an engine from every host. Only engines that are already off appear. */
  import { Section } from "$lib/components/page";
  import { authStore } from "$lib/stores/auth";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import EngineDestroyPanel from "$lib/components/settings/EngineDestroyPanel.svelte";

  const fleet = useFleetEngines();
  const canMutate = $derived($authStore.can("settings.manage"));
</script>

{#if $fleet.known && $fleet.disabled.length}
  <Section id="engine-danger" danger title="Danger zone" description="Irreversible. Available only for engines that are switched off above.">
    <div class="divide-y">
      {#each $fleet.disabled as engine (engine)}
        <EngineDestroyPanel {engine} suspended={true} {canMutate} />
      {/each}
    </div>
  </Section>
{/if}
