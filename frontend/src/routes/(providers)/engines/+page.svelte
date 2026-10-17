<script lang="ts">
  import { onMount } from "svelte";
  import ChattySettings from "$lib/components/chatty/ChattySettings.svelte";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import CodexVersionSection from "$lib/components/settings/CodexVersionSection.svelte";
  import GrokVersionSection from "$lib/components/settings/GrokVersionSection.svelte";
  import ClaudeVersionSection from "$lib/components/settings/ClaudeVersionSection.svelte";
  import CdxSilentSection from "$lib/components/settings/CdxSilentSection.svelte";
  import CodexCompactionSection from "$lib/components/settings/CodexCompactionSection.svelte";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
  import ScalingSection from "$lib/components/settings/ScalingSection.svelte";
  import NativeSettingsEditor from "$lib/components/settings/NativeSettingsEditor.svelte";
  import ClaudeFleetSettings from "$lib/components/settings/ClaudeFleetSettings.svelte";
  import EngineMasterSwitches from "$lib/components/settings/EngineMasterSwitches.svelte";
  import WrapperRolloutSection from "$lib/components/settings/WrapperRolloutSection.svelte";
  import QuickModelDefaults from "$lib/components/settings/QuickModelDefaults.svelte";
  import EngineTab from "$lib/components/engines/EngineTab.svelte";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { ENGINE_META } from "$lib/constants/engines";
  import {
    ENGINE_PAGE_TABS,
    engineHash,
    resolveEngineHash,
    type EnginePageTab,
    type EngineSubTab,
  } from "$lib/engines/engine-tabs";
  import { base } from "$app/paths";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";

  const fleet = useFleetEngines();
  const STORE_KEY = "engines.tab";

  let tab = $state<EnginePageTab>("fleet");
  let subs = $state<Partial<Record<EnginePageTab, EngineSubTab | null>>>({});

  function select(next: EnginePageTab, sub: EngineSubTab | null = subs[next] ?? null) {
    tab = next;
    subs[next] = sub;
    history.replaceState(history.state, "", engineHash(next, sub));
    try { localStorage.setItem(STORE_KEY, engineHash(next, sub)); } catch { /* storage may be blocked */ }
  }

  function apply(hash: string): boolean {
    const target = resolveEngineHash(hash);
    if (!target) return false;
    tab = target.tab;
    subs[target.tab] = target.sub;
    return true;
  }

  onMount(() => {
    if (!apply(location.hash)) {
      try { apply(localStorage.getItem(STORE_KEY) ?? ""); } catch { /* default tab */ }
    }
    const onHash = () => apply(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  const labels: Record<EnginePageTab, string> = {
    fleet: "Fleet",
    defaults: "Model defaults",
    codex: ENGINE_META.codex.label,
    claude: ENGINE_META.claude.label,
    grok: ENGINE_META.grok.label,
  };
  const dots: Partial<Record<EnginePageTab, string>> = {
    codex: ENGINE_META.codex.color,
    claude: ENGINE_META.claude.color,
    grok: ENGINE_META.grok.color,
  };
</script>

<PageHeader title="Engines" subtitle="One fleet. Three engines. Switch them, set defaults, control updates, tune each client.">
  {#snippet actions()}
    <Button variant="outline" href={`${base}/hosts`}>Host overrides <ArrowUpRight class="h-4 w-4" /></Button>
  {/snippet}
</PageHeader>

<EngineMasterSwitches variant="strip" />

<Tabs.Root value={tab} onValueChange={(v) => select(v as EnginePageTab)}>
  <Tabs.List aria-label="Engine settings" class="max-w-full overflow-x-auto">
    {#each ENGINE_PAGE_TABS as t (t)}
      <Tabs.Trigger value={t} class="gap-2">
        {#if dots[t]}<span class="h-2 w-2 rounded-full {dots[t]}" aria-hidden="true"></span>{/if}
        {labels[t]}
        {#if t !== "fleet" && !$fleet.isEnabled(t)}<Badge variant="warning">Off</Badge>{/if}
      </Tabs.Trigger>
    {/each}
  </Tabs.List>

  <Tabs.Content value="fleet" class="mt-4 space-y-4">
    <section id="cxx-rollout" class="scroll-mt-16"><WrapperRolloutSection headingLevel={3} /></section>
    <section id="quota-enforcement" class="scroll-mt-16">
      <QuotasSection headingLevel={3} />
      <ScalingSection headingLevel={3} />
    </section>
    <ChattySettings />
  </Tabs.Content>

  <Tabs.Content value="defaults" class="mt-4">
    <p class="mb-3 max-w-3xl text-sm text-muted-foreground">
      Choose model, effort, and Grok context defaults. Changes save immediately and apply when managed clients next sync; host overrides take precedence.
    </p>
    <div class="grid items-start gap-5 xl:grid-cols-3">
      <QuickModelDefaults engine="codex" />
      <QuickModelDefaults engine="claude" />
      <QuickModelDefaults engine="grok" />
    </div>
  </Tabs.Content>

  <Tabs.Content value="codex" class="mt-4" id="codex-defaults">
    <EngineTab engine="codex" sub={subs.codex ?? null} onSub={(s) => select("codex", s)}>
      {#snippet versions()}
        <CodexVersionSection headingLevel={3} />
        <CdxSilentSection bordered={false} />
        <CodexCompactionSection />
      {/snippet}
      {#snippet nativeExtra()}<NativeSettingsEditor engine="codex" profiles />{/snippet}
    </EngineTab>
  </Tabs.Content>

  <Tabs.Content value="claude" class="mt-4" id="claude-defaults">
    <EngineTab engine="claude" sub={subs.claude ?? null} onSub={(s) => select("claude", s)}>
      {#snippet versions()}<ClaudeVersionSection headingLevel={3} />{/snippet}
      {#snippet client()}
        <p id="claude-client" class="mb-3 max-w-3xl text-sm text-muted-foreground">
          Owned Claude Code settings are deep-merged; user-authored settings remain intact.
        </p>
        <ClaudeFleetSettings />
      {/snippet}
    </EngineTab>
  </Tabs.Content>

  <Tabs.Content value="grok" class="mt-4" id="grok-defaults">
    <EngineTab engine="grok" sub={subs.grok ?? null} onSub={(s) => select("grok", s)}>
      {#snippet versions()}<GrokVersionSection headingLevel={3} />{/snippet}
    </EngineTab>
  </Tabs.Content>
</Tabs.Root>
