<script lang="ts">
  import { tick } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import * as Tabs from "$lib/components/ui/tabs";
  import ApiStateSection from "$lib/components/settings/ApiStateSection.svelte";
  import OpenAIEngineSection from "$lib/components/settings/OpenAIEngineSection.svelte";
  import ClaudeEngineSection from "$lib/components/settings/ClaudeEngineSection.svelte";
  import ReverseDnsSection from "$lib/components/settings/ReverseDnsSection.svelte";
  import AutoUpdateSection from "$lib/components/settings/AutoUpdateSection.svelte";
  import CdxSilentSection from "$lib/components/settings/CdxSilentSection.svelte";
  import InsecureApprovalSection from "$lib/components/settings/InsecureApprovalSection.svelte";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
  import CodexVersionSection from "$lib/components/settings/CodexVersionSection.svelte";
  import ClaudeVersionSection from "$lib/components/settings/ClaudeVersionSection.svelte";
  import ScalingSection from "$lib/components/settings/ScalingSection.svelte";
  import PrunePolicySection from "$lib/components/settings/PrunePolicySection.svelte";
  import LogRetentionSection from "$lib/components/settings/LogRetentionSection.svelte";
  import ClaudeFleetSettings from "$lib/components/settings/ClaudeFleetSettings.svelte";
  import ModelDefaultsSection from "$lib/components/settings/ModelDefaultsSection.svelte";

  type SettingsTab = "general" | "codex" | "claude";

  const TABS = [
    { value: "general", label: "General" },
    { value: "codex", label: "Codex" },
    { value: "claude", label: "Claude" },
  ] as const;

  const SECTION_TABS: Record<string, SettingsTab> = {
    "api-state": "general",
    "auto-update": "general",
    "reverse-dns": "general",
    "insecure-approval": "general",
    "prune-policy": "general",
    "log-retention": "general",
    "openai-engine": "codex",
    "codex-model-defaults": "codex",
    "codex-version": "codex",
    "cdx-silent": "codex",
    quotas: "codex",
    scaling: "codex",
    "claude-engine": "claude",
    "claude-model-defaults": "claude",
    "claude-version": "claude",
    "claude-fleet-settings": "claude",
  };

  function isSettingsTab(value: string | null): value is SettingsTab {
    return value === "general" || value === "codex" || value === "claude";
  }

  function hashSection(url: URL): string {
    if (!url.hash) return "";
    try {
      return decodeURIComponent(url.hash.slice(1));
    } catch {
      return url.hash.slice(1);
    }
  }

  function tabFromUrl(url: URL): SettingsTab {
    const requested = url.searchParams.get("tab");
    if (requested !== null) return isSettingsTab(requested) ? requested : "general";
    return SECTION_TABS[hashSection(url)] ?? "general";
  }

  const activeTab = $derived(tabFromUrl(page.url));
  let lastScrolledTarget = "";

  function handleTabChange(value: unknown) {
    if (typeof value !== "string" || !isSettingsTab(value) || value === activeTab) return;
    void goto(`${base}/settings?tab=${value}`, {
      keepFocus: true,
      noScroll: true,
    });
  }

  $effect(() => {
    const section = hashSection(page.url);
    const tab = activeTab;
    if (!section || (SECTION_TABS[section] && SECTION_TABS[section] !== tab)) {
      lastScrolledTarget = "";
      return;
    }

    const targetKey = `${tab}:${section}`;
    if (targetKey === lastScrolledTarget) return;
    lastScrolledTarget = targetKey;
    void tick().then(() => {
      document.getElementById(section)?.scrollIntoView({ block: "start" });
    });
  });
</script>

<PageHeader title="Settings" subtitle="System and engine configuration" class="mb-4" />

<Tabs.Root value={activeTab} onValueChange={handleTabChange} class="w-full">
  <Tabs.List class="grid w-full grid-cols-3 sm:inline-grid sm:w-auto">
    {#each TABS as tab (tab.value)}
      <Tabs.Trigger value={tab.value}>{tab.label}</Tabs.Trigger>
    {/each}
  </Tabs.List>

  <Tabs.Content value="general" class="pt-3">
    <div class="grid items-start gap-3 xl:grid-cols-2">
      <ApiStateSection />
      <AutoUpdateSection />
      <ReverseDnsSection />
      <InsecureApprovalSection />
      <PrunePolicySection />
      <LogRetentionSection />
    </div>
  </Tabs.Content>

  <Tabs.Content value="codex" class="pt-3">
    <div class="grid items-start gap-3 xl:grid-cols-2">
      <div class="xl:col-span-2">
        <ModelDefaultsSection engine="codex" />
      </div>
      <OpenAIEngineSection />
      <CdxSilentSection />
      <CodexVersionSection />
      <QuotasSection />
      <div class="xl:col-span-2">
        <ScalingSection />
      </div>
    </div>
  </Tabs.Content>

  <Tabs.Content value="claude" class="space-y-3 pt-3">
    <div class="grid items-start gap-3 xl:grid-cols-2">
      <div class="xl:col-span-2">
        <ModelDefaultsSection engine="claude" />
      </div>
      <ClaudeEngineSection />
      <ClaudeVersionSection />
    </div>
    <div class="space-y-4">
      <ClaudeFleetSettings />
    </div>
  </Tabs.Content>
</Tabs.Root>
