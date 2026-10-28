<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { PageShell } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Tabs from "$lib/components/ui/tabs";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import EngineMasterSwitches from "$lib/components/settings/EngineMasterSwitches.svelte";
  import EngineSection from "$lib/components/engines/EngineSection.svelte";
  import EngineDangerZone from "$lib/components/engines/EngineDangerZone.svelte";
  import { advancedEngineForHash, movedAnchorTarget, tabEngineForHash } from "$lib/components/engines/engine-anchors";
  import { ENGINES, ENGINE_META, isEngine, type Engine } from "$lib/constants/engines";
  import { useFleetEngines } from "$lib/engines/fleet-engines";

  const fleet = useFleetEngines();

  // One engine at a time. The tab lives in the URL so a reload or a shared link
  // lands on the same one; without it, the first engine that is switched on.
  const requested = $derived(page.url.searchParams.get("engine") ?? "");
  const current = $derived<Engine>(isEngine(requested) ? requested : ($fleet.enabled[0] ?? ENGINES[0]));

  // Which engine's Advanced disclosure is open. Closed content is not rendered,
  // so a hash that points inside one (`#claude-client`) must open it before
  // the browser can scroll there.
  let advanced = $state<Record<Engine, boolean>>({ codex: false, claude: false, grok: false });

  function selectEngine(engine: string) {
    if (!isEngine(engine)) return;
    void goto(`?engine=${engine}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  let followedHash = "";

  async function follow(hash: string) {
    followedHash = hash;
    // Sections that moved to /limits and /settings keep their old bookmarks working.
    const moved = movedAnchorTarget(hash);
    if (moved) return void goto(`${base}${moved}`, { replaceState: true });

    const engine = tabEngineForHash(hash);
    if (engine && engine !== current) await goto(`?engine=${engine}${hash}`, { replaceState: true, noScroll: true, keepFocus: true });
    const advancedEngine = advancedEngineForHash(hash);
    if (advancedEngine) advanced[advancedEngine] = true;
    const id = hash.replace(/^#/, "");
    if (!id) return;
    await tick();
    // Forms above the target load after the first paint and push it down, so
    // scroll again once they have settled. Tab and Advanced are already open.
    for (const delay of [0, 250, 700]) {
      setTimeout(() => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" })), delay);
    }
  }

  // A client-side navigation to another section of this page (the command palette's
  // `goto`) changes the URL without firing `hashchange`, so follow the router's hash too.
  $effect(() => {
    const hash = page.url.hash;
    untrack(() => { if (hash && hash !== followedHash) void follow(hash); });
  });

  onMount(() => {
    void follow(location.hash);
    const onHash = () => void follow(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });
</script>

<PageShell title="Engines" description="Turn engines on or off and set what new sessions of each use. Per-host exceptions override these defaults; quotas and scaling are under Usage limits.">
  {#snippet actions()}
    <Button variant="outline" href={`${base}/hosts`} title="Host overrides">Per-host exceptions <ArrowUpRight class="h-4 w-4" /></Button>
  {/snippet}

  <div id="engine-state" class="scroll-mt-20"><EngineMasterSwitches /></div>

  <Tabs.Root value={current} onValueChange={selectEngine} class="flex flex-col gap-4">
    <Tabs.List class="w-fit" aria-label="Engine defaults">
      {#each ENGINES as engine (engine)}
        <Tabs.Trigger value={engine} class="gap-2">
          <span class="h-2 w-2 shrink-0 rounded-full {ENGINE_META[engine].color}" aria-hidden="true"></span>
          {ENGINE_META[engine].label}
          {#if $fleet.known && !$fleet.isEnabled(engine)}<Badge variant="warning">Off</Badge>{/if}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>

    {#each ENGINES as engine (engine)}
      <Tabs.Content value={engine} class="space-y-8">
        <div id={engine === current ? "defaults" : undefined} class="scroll-mt-20">
          <EngineSection {engine} bind:advancedOpen={advanced[engine]} />
        </div>
        <EngineDangerZone {engine} />
      </Tabs.Content>
    {/each}
  </Tabs.Root>
</PageShell>
