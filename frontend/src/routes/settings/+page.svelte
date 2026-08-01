<script lang="ts">
  import { tick } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Card from "$lib/components/ui/card";
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
  import AgentMessagingSection from "$lib/components/settings/AgentMessagingSection.svelte";

  type SettingsTab = "availability" | "engines" | "fleet-policy" | "claude-config";

  const TABS = [
    { value: "availability", label: "Availability" },
    { value: "engines", label: "Engines & models" },
    { value: "fleet-policy", label: "Fleet policy" },
    { value: "claude-config", label: "Claude config" },
  ] as const;

  // Owning tab per section id — the source of truth for both the `?tab=`
  // param a click writes and which tab a `#section` hash resolves to.
  const SECTION_TABS: Record<string, SettingsTab> = {
    "api-state": "availability",
    "openai-engine": "availability",
    "claude-engine": "availability",
    "agent-messaging": "availability",
    "codex-model-defaults": "engines",
    "claude-model-defaults": "engines",
    "codex-version": "engines",
    "claude-version": "engines",
    "cdx-silent": "engines",
    quotas: "engines",
    scaling: "engines",
    "auto-update": "fleet-policy",
    "reverse-dns": "fleet-policy",
    "insecure-approval": "fleet-policy",
    "prune-policy": "fleet-policy",
    "log-retention": "fleet-policy",
    "claude-fleet-settings": "claude-config",
  };

  // Old tab param values, kept working verbatim rather than 404ing a
  // bookmarked or externally-linked URL after the engine-axis retirement.
  const LEGACY_TAB_ALIASES: Record<string, SettingsTab> = {
    general: "availability",
    codex: "engines",
    claude: "engines",
  };

  function isSettingsTab(value: string | null): value is SettingsTab {
    return value === "availability" || value === "engines" || value === "fleet-policy" || value === "claude-config";
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
    // A recognized hash always wins, even over a stale/mismatched `?tab=` —
    // otherwise a bookmarked link into a section that moved tabs in the
    // re-axis lands on the wrong tab and the scroll-into-view below silently
    // no-ops because the target element isn't in that tab's DOM.
    const owningTab = SECTION_TABS[hashSection(url)];
    if (owningTab) return owningTab;

    const requested = url.searchParams.get("tab");
    if (requested !== null) {
      if (isSettingsTab(requested)) return requested;
      const alias = LEGACY_TAB_ALIASES[requested];
      if (alias) return alias;
    }
    return "availability";
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

  // `agent-portal` left the tab strip entirely for its own route — a
  // bookmarked `#agent-portal` hash has nowhere to scroll to any more, so
  // send it on rather than silently stranding it on the default tab.
  $effect(() => {
    if (hashSection(page.url) === "agent-portal") {
      void goto(`${base}/settings/agent-portal`, { replaceState: true });
    }
  });

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

<Tabs.Root value={activeTab} onValueChange={handleTabChange} class="w-full">
  <Tabs.List class="grid w-full grid-cols-2 gap-1 sm:inline-grid sm:w-auto sm:grid-cols-4">
    {#each TABS as tab (tab.value)}
      <Tabs.Trigger value={tab.value}>{tab.label}</Tabs.Trigger>
    {/each}
  </Tabs.List>

  <Tabs.Content value="availability" class="pt-3">
    <div class="grid items-start gap-3 xl:grid-cols-2">
      <div class="xl:col-span-2">
        <Card.Root>
          <Card.Header>
            <Card.Title>Kill switches</Card.Title>
            <Card.Description>Disabling API traffic overrides the OpenAI/Codex switch below it. Claude API proxy and Agent Messaging, to the right, are independent subsystems with their own switches.</Card.Description>
          </Card.Header>
          <Card.Content class="divide-y divide-border">
            <ApiStateSection bordered={false} />
            <OpenAIEngineSection bordered={false} />
          </Card.Content>
        </Card.Root>
      </div>
      <ClaudeEngineSection />
      <AgentMessagingSection />
    </div>
  </Tabs.Content>

  <Tabs.Content value="engines" class="pt-3">
    <div class="grid items-start gap-3 xl:grid-cols-2">
      <div class="xl:col-span-2">
        <ModelDefaultsSection engine="codex" />
      </div>
      <div class="xl:col-span-2">
        <ModelDefaultsSection engine="claude" />
      </div>
      <CodexVersionSection />
      <ClaudeVersionSection />
      <CdxSilentSection />
      <QuotasSection />
      <div class="xl:col-span-2">
        <ScalingSection />
      </div>
    </div>
  </Tabs.Content>

  <Tabs.Content value="fleet-policy" class="pt-3">
    <div class="grid items-start gap-3 xl:grid-cols-2">
      <Card.Root>
        <Card.Header>
          <Card.Title>Fleet toggles</Card.Title>
        </Card.Header>
        <Card.Content class="divide-y divide-border">
          <AutoUpdateSection bordered={false} />
          <ReverseDnsSection bordered={false} />
        </Card.Content>
      </Card.Root>
      <InsecureApprovalSection />
      <PrunePolicySection />
      <LogRetentionSection />
    </div>
  </Tabs.Content>

  <Tabs.Content value="claude-config" class="pt-3">
    <ClaudeFleetSettings />
  </Tabs.Content>
</Tabs.Root>
