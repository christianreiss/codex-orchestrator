<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import Plus from "@lucide/svelte/icons/plus";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Tabs from "$lib/components/ui/tabs";
  import KeysTable from "$lib/components/api-keys/KeysTable.svelte";
  import NewKeyDialog from "$lib/components/api-keys/NewKeyDialog.svelte";
  import ExposedApisTable from "$lib/components/api-keys/ExposedApisTable.svelte";
  import ApiStateSection from "$lib/components/settings/ApiStateSection.svelte";
  import GrokEngineSection from "$lib/components/settings/GrokEngineSection.svelte";
  import ClaudeEngineSection from "$lib/components/settings/ClaudeEngineSection.svelte";
  import type { ApiKeyEngine } from "$lib/api/types";

  let dialogOpen = $state(false);
  let dialogEngine = $state<ApiKeyEngine>("openai");
  let activeTab = $state<ApiKeyEngine>("openai");

  function openDialog(engine: ApiKeyEngine) {
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
  subtitle="Manage service availability, compatible endpoints, credentials, and issued API keys."
>
  {#snippet actions()}
    <Button onclick={() => openDialog(activeTab)}>
      <Plus class="h-4 w-4" />
      New key
    </Button>
  {/snippet}
</PageHeader>

<section id="service-availability" class="setting-boundary mb-5">
  <div class="setting-boundary__head">
    <h2>Service availability</h2>
    <p>The master switch for all API traffic. Each exposed API has its own switch in the table below.</p>
  </div>
  <div class="divide-y">
    <ApiStateSection bordered={false} />
  </div>
</section>

<section id="exposed-apis" class="mb-5 flex flex-col gap-2">
  <h2 class="section-label">Exposed APIs</h2>
  <ExposedApisTable
    onShowKeys={(tab) => {
      activeTab = tab;
      document.getElementById("api-keys")?.scrollIntoView({ behavior: "smooth" });
    }}
  />
</section>

<section id="backend-settings" class="mb-5 flex flex-col gap-3">
  <h2 class="section-label">Backend settings</h2>
  <div id="claude-proxy"><ClaudeEngineSection /></div>
  <div id="grok-proxy"><GrokEngineSection /></div>
</section>

<Tabs.Root id="api-keys" class="mt-6" value={activeTab} onValueChange={(v) => (activeTab = v as ApiKeyEngine)}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <Tabs.List>
      <Tabs.Trigger value="openai">/v1</Tabs.Trigger>
      <Tabs.Trigger value="claude">/anthropic/v1</Tabs.Trigger>
      <Tabs.Trigger value="grok">/grok/v1</Tabs.Trigger>
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

<NewKeyDialog
  bind:open={dialogOpen}
  defaultEngine={dialogEngine}
  onOpenChange={(next) => {
    dialogOpen = next;
    if (!next) clearDialogParam();
  }}
/>
