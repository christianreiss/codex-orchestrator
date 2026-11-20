<script lang="ts">
  import { ChoiceCard } from "$lib/components/ui/choice-card";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  let { engines = $bindable() }: { engines: Engine[] } = $props();
  // A fleet-disabled engine is not part of the fleet: it gets no card and
  // cannot be picked (the server refuses seeding or installing it anyway).
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
  <div role="group" aria-label="Engines" class="grid gap-3 sm:grid-cols-2">
    {#each $fleet.enabled as engine (engine)}
      <ChoiceCard
        mode="checkbox"
        title={ENGINE_META[engine].label}
        description={`Hosts get the ${ENGINE_META[engine].command} alias.`}
        checked={engines.includes(engine)}
        onSelect={() => toggle(engine)}
      />
    {/each}
  </div>
  <div class="flex gap-2">
    <Button variant="outline" size="sm" disabled={$fleet.enabled.length === 0} onclick={() => engines = [...$fleet.enabled]}>
      All engines
    </Button>
    <Button variant="outline" size="sm" onclick={() => engines = []}>None yet</Button>
  </div>
  <p class="text-body-sm text-muted-foreground">Choose any combination. Engines can still be chosen per host, and credentials can be seeded later from Accounts or Hosts.</p>
</div>
