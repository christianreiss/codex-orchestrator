<script lang="ts">
  /** Last block of an engine tab: remove that engine from every host. Appears only while the engine is switched off. */
  import { Section } from "$lib/components/page";
  import { authStore } from "$lib/stores/auth";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import type { Engine } from "$lib/constants/engines";
  import EngineDestroyPanel from "$lib/components/settings/EngineDestroyPanel.svelte";

  let { engine }: { engine: Engine } = $props();

  const fleet = useFleetEngines();
  const canMutate = $derived($authStore.can("settings.manage"));
</script>

{#if $fleet.known && $fleet.disabled.includes(engine)}
  <Section id="{engine}-danger" danger title="Danger zone" description="Irreversible. Available only while this engine is switched off above.">
    <EngineDestroyPanel {engine} suspended={true} {canMutate} />
  </Section>
{/if}
