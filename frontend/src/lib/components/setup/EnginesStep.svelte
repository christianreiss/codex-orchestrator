<script lang="ts">
  import { ChoiceCard } from "$lib/components/ui/choice-card";
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  let { engines = $bindable() }: { engines: Engine[] } = $props();
  function toggle(engine: Engine) {
    engines = engines.includes(engine) ? engines.filter((item) => item !== engine) : [...engines, engine];
  }
</script>

<div class="space-y-3">
  <div role="group" aria-label="Engines" class="grid gap-3 sm:grid-cols-3">
    {#each ENGINES as engine (engine)}
      <ChoiceCard mode="checkbox" title={ENGINE_META[engine].label} description={`Hosts get the ${ENGINE_META[engine].command} alias.`} checked={engines.includes(engine)} onSelect={() => toggle(engine)} />
    {/each}
  </div>
  <div class="flex gap-2">
    <Button variant="outline" size="sm" onclick={() => engines = [...ENGINES]}>All engines</Button>
    <Button variant="outline" size="sm" onclick={() => engines = []}>None yet</Button>
  </div>
  <p class="text-xs text-muted-foreground">Choose any combination. Engines can still be chosen per host, and credentials can be seeded later from Accounts or Hosts.</p>
</div>
