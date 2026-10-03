<script lang="ts">
  import { ChoiceCard } from "$lib/components/ui/choice-card";
  import { Badge } from "$lib/components/ui/badge";
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  import { useFleetEngines, FLEET_DISABLED_TAG, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  let { engines = $bindable() }: { engines: Engine[] } = $props();
  // A fleet-disabled engine cannot be seeded or installed, so it cannot be
  // picked here; the card stays visible, disabled, to say why.
  const fleet = useFleetEngines();
  // Keep the recorded answer equal to what the cards show: an engine switched
  // off after it was chosen drops out of the selection.
  $effect(() => {
    const kept = engines.filter((engine) => $fleet.isEnabled(engine));
    if (kept.length !== engines.length) engines = kept;
  });
  function toggle(engine: Engine) {
    if (!$fleet.isEnabled(engine)) return;
    engines = engines.includes(engine) ? engines.filter((item) => item !== engine) : [...engines, engine];
  }
</script>

<div class="space-y-3">
  <div role="group" aria-label="Engines" class="grid gap-3 sm:grid-cols-3">
    {#each ENGINES as engine (engine)}
      {@const off = !$fleet.isEnabled(engine)}
      <ChoiceCard
        mode="checkbox"
        title={ENGINE_META[engine].label}
        description={off ? fleetDisabledTitle(ENGINE_META[engine].label) : `Hosts get the ${ENGINE_META[engine].command} alias.`}
        checked={!off && engines.includes(engine)}
        disabled={off}
        onSelect={() => toggle(engine)}
      >
        {#snippet badge()}{#if off}<Badge variant="outline">{FLEET_DISABLED_TAG}</Badge>{/if}{/snippet}
      </ChoiceCard>
    {/each}
  </div>
  <div class="flex gap-2">
    <Button variant="outline" size="sm" disabled={$fleet.enabled.length === 0} onclick={() => engines = [...$fleet.enabled]}>
      {$fleet.disabled.length === 0 ? "All engines" : "All enabled engines"}
    </Button>
    <Button variant="outline" size="sm" onclick={() => engines = []}>None yet</Button>
  </div>
  <p class="text-xs text-muted-foreground">Choose any combination. Engines can still be chosen per host, and credentials can be seeded later from Accounts or Hosts.</p>
</div>
