<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { tick } from "svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Tabs from "$lib/components/ui/tabs";
  import KeysTable from "$lib/components/api-keys/KeysTable.svelte";
  import NewKeyDialog from "$lib/components/api-keys/NewKeyDialog.svelte";
  import ExposedApisTable from "$lib/components/api-keys/ExposedApisTable.svelte";
  import EndpointSummary from "$lib/components/api-keys/EndpointSummary.svelte";
  import ApiStateSection from "$lib/components/settings/ApiStateSection.svelte";
  import GrokEngineSection from "$lib/components/settings/GrokEngineSection.svelte";
  import ClaudeEngineSection from "$lib/components/settings/ClaudeEngineSection.svelte";
  import type { ApiKeyEngine } from "$lib/api/types";

  let dialogOpen = $state(false);
  let dialogEngine = $state<ApiKeyEngine>("openai");
  let activeTab = $state<ApiKeyEngine>("openai");
  let claudeOpen = $state(false);
  let grokOpen = $state(false);
  const configAnchors = new Set(["configuration", "service-availability", "api-state", "exposed-apis", "backend-settings", "claude-proxy", "claude-engine", "grok-proxy", "grok-engine"]);
  const configuration = $derived(configAnchors.has(page.url.hash.slice(1)));

  function navigateTo(anchor: string) {
    const url = new URL(page.url);
    url.hash = anchor;
    void goto(url, { keepFocus: true, noScroll: true });
  }

  function showKeys(tab: ApiKeyEngine) {
    activeTab = tab;
    navigateTo("api-keys");
  }

  $effect(() => {
    const anchor = page.url.hash.slice(1);
    if (anchor === "claude-proxy" || anchor === "claude-engine") claudeOpen = true;
    if (anchor === "grok-proxy" || anchor === "grok-engine") grokOpen = true;
    if (anchor) void tick().then(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
  });

  function openDialog(engine: ApiKeyEngine) {
    activeTab = engine;
    dialogEngine = engine;
    dialogOpen = true;
  }

  function clearDialogParam(): void {
    if (page.url.searchParams.get("dialog") !== "new") return;
    const url = new URL(page.url);
    url.searchParams.delete("dialog");
    url.searchParams.delete("engine");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  $effect(() => {
    if (page.url.searchParams.get("dialog") !== "new") return;
    const requestedEngine = page.url.searchParams.get("engine");
    openDialog(requestedEngine === "grok" ? "grok" : requestedEngine === "claude" ? "claude" : "openai");
  });
</script>

<PageHeader
  title="API Access"
  subtitle="Connect your applications and manage their keys."
>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => navigateTo(configuration ? "api-keys" : "configuration")}>
      {#if configuration}<ArrowLeft class="h-4 w-4" />Back to keys{:else}<Settings2 class="h-4 w-4" />Configuration{/if}
    </Button>
    <Button onclick={() => openDialog(activeTab)}>
      <Plus class="h-4 w-4" />
      New key
    </Button>
  {/snippet}
</PageHeader>

<div hidden={configuration}>
  <EndpointSummary {activeTab} onSelect={showKeys} />
  <Tabs.Root id="api-keys" class="scroll-mt-20" value={activeTab} onValueChange={(v) => (activeTab = v as ApiKeyEngine)}>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-sm font-semibold">API keys</h2>
      <Tabs.List aria-label="API keys by endpoint">
        <Tabs.Trigger value="openai">OpenAI</Tabs.Trigger>
        <Tabs.Trigger value="claude">Anthropic</Tabs.Trigger>
        <Tabs.Trigger value="grok">Grok</Tabs.Trigger>
      </Tabs.List>
    </div>

    <Tabs.Content value="openai" class="mt-4">
      <KeysTable engine="openai" />
    </Tabs.Content>

    <Tabs.Content value="claude" class="mt-4">
      <KeysTable engine="claude" />
    </Tabs.Content>
    <Tabs.Content value="grok" class="mt-4"><KeysTable engine="grok" /></Tabs.Content>
  </Tabs.Root>
</div>

<div id="configuration" hidden={!configuration} class="scroll-mt-20 space-y-6">
  <section id="exposed-apis" class="scroll-mt-20 space-y-3">
    <h2 class="text-sm font-semibold">Routing &amp; availability</h2>
    <ExposedApisTable onShowKeys={showKeys} />
  </section>
  <section id="backend-settings" class="scroll-mt-20">
    <h2 class="mb-2 text-sm font-semibold">Backend defaults</h2>
    <details id="claude-proxy" bind:open={claudeOpen} class="scroll-mt-20 border-b">
      <summary class="cursor-pointer py-3 text-sm">Claude <span class="ml-2 text-xs text-muted-foreground">Model &amp; token limit</span></summary>
      <ClaudeEngineSection />
    </details>
    <details id="grok-proxy" bind:open={grokOpen} class="scroll-mt-20 border-b">
      <summary class="cursor-pointer py-3 text-sm">Grok <span class="ml-2 text-xs text-muted-foreground">Default model &amp; available models</span></summary>
      <GrokEngineSection />
    </details>
  </section>
  <section id="service-availability" class="scroll-mt-20 border-t pt-4">
    <h2 class="text-sm font-semibold">Global API control</h2>
    <ApiStateSection bordered={false} />
  </section>
</div>

<NewKeyDialog
  bind:open={dialogOpen}
  defaultEngine={dialogEngine}
  onOpenChange={(next) => {
    dialogOpen = next;
    if (!next) clearDialogParam();
  }}
/>
