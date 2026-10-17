<script lang="ts">
  import { onMount, tick } from "svelte";
  import { base } from "$app/paths";
  import { PageShell, Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import ChattySettings from "$lib/components/chatty/ChattySettings.svelte";
  import EngineMasterSwitches from "$lib/components/settings/EngineMasterSwitches.svelte";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
  import ScalingSection from "$lib/components/settings/ScalingSection.svelte";
  import WrapperRolloutSection from "$lib/components/settings/WrapperRolloutSection.svelte";
  import EngineSection from "$lib/components/engines/EngineSection.svelte";
  import EngineDangerZone from "$lib/components/engines/EngineDangerZone.svelte";
  import { advancedEngineForHash } from "$lib/components/engines/engine-anchors";
  import { ENGINES, type Engine } from "$lib/constants/engines";

  // Which engine's Advanced disclosure is open. Closed content is not rendered,
  // so a hash that points inside one (`#claude-client`) must open it before
  // the browser can scroll there.
  let advanced = $state<Record<Engine, boolean>>({ codex: false, claude: false, grok: false });

  async function follow(hash: string) {
    const engine = advancedEngineForHash(hash);
    if (engine) advanced[engine] = true;
    const id = hash.replace(/^#/, "");
    if (!id) return;
    await tick();
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  }

  onMount(() => {
    void follow(location.hash);
    const onHash = () => void follow(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });
</script>

<PageShell title="Engines" description="Turn engines on or off, set what new sessions use, and control updates. Per-host exceptions override these defaults.">
  {#snippet actions()}
    <Button variant="outline" href={`${base}/hosts`} title="Host overrides">Per-host exceptions <ArrowUpRight class="h-4 w-4" /></Button>
  {/snippet}

  <div id="engine-state" class="scroll-mt-20"><EngineMasterSwitches /></div>

  <div id="defaults" class="scroll-mt-20 space-y-8">
    {#each ENGINES as engine (engine)}
      <EngineSection {engine} bind:advancedOpen={advanced[engine]} />
    {/each}
  </div>

  <Section id="quota-enforcement" title="Usage limits" description="What happens when an account nears its quota, and how clients are advised to switch provider.">
    <QuotasSection />
  </Section>

  <Section id="scaling-rules" title="Usage-based scaling" description="Tiers that change lane, effort or model as fleet usage rises. Hosts marked Always allowed (they ignore usage limits) are exempt.">
    <ScalingSection />
  </Section>

  <Section id="cxx-rollout" title="Host agent rollout" description="Try new host-agent versions early: a few hosts get each new cxx release first, the rest follow in stages.">
    <WrapperRolloutSection headingLevel={3} />
  </Section>

  <ChattySettings />

  <EngineDangerZone />
</PageShell>
