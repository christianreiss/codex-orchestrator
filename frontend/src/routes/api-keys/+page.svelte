<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import Plus from "@lucide/svelte/icons/plus";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import * as Tabs from "$lib/components/ui/tabs";
  import KeysTable from "$lib/components/api-keys/KeysTable.svelte";
  import NewKeyDialog from "$lib/components/api-keys/NewKeyDialog.svelte";
  import ApiStateSection from "$lib/components/settings/ApiStateSection.svelte";
  import OpenAIEngineSection from "$lib/components/settings/OpenAIEngineSection.svelte";
  import ClaudeEngineSection from "$lib/components/settings/ClaudeEngineSection.svelte";
  import type { ApiKeyEngine } from "$lib/api/types";

  let dialogOpen = $state(false);
  let dialogEngine = $state<ApiKeyEngine>("openai");
  let activeTab = $state<ApiKeyEngine>("openai");
  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const proxyEndpoints = $derived([
    {
      engine: "OpenAI",
      detail: "OpenAI-compatible base URL",
      path: "/v1",
      url: `${origin}/v1`,
    },
    {
      engine: "Claude",
      detail: "Anthropic-compatible base URL",
      path: "/anthropic/v1",
      url: `${origin}/anthropic/v1`,
    },
  ]);

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
    openDialog(requestedEngine === "claude" ? "claude" : "openai");
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
    <p>Master API state and OpenAI/Claude-compatible proxy controls live here, next to the credentials they govern.</p>
  </div>
  <div class="divide-y">
    <ApiStateSection bordered={false} />
    <OpenAIEngineSection bordered={false} />
  </div>
  <div id="claude-proxy" class="mt-3"><ClaudeEngineSection /></div>
</section>

<section id="proxy-endpoints" class="mb-5 flex flex-col gap-2">
  <h2 class="section-label">Proxy endpoints</h2>
  {#each proxyEndpoints as endpoint}
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-card px-3 py-2.5">
      <div class="min-w-0">
        <p class="text-sm">
          <span class="font-medium">{endpoint.engine}</span>
          <span class="text-muted-foreground"> · {endpoint.detail}</span>
        </p>
        <code class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
          {endpoint.url || endpoint.path}
        </code>
      </div>
      <CopyButton
        value={endpoint.url || endpoint.path}
        label="Copy"
        copiedLabel="Copied"
        size="sm"
        toastMessage={`${endpoint.engine} URL copied`}
      />
    </div>
  {/each}
</section>

<Tabs.Root class="mt-6" value={activeTab} onValueChange={(v) => (activeTab = v as ApiKeyEngine)}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <Tabs.List>
      <Tabs.Trigger value="openai">OpenAI</Tabs.Trigger>
      <Tabs.Trigger value="claude">Anthropic</Tabs.Trigger>
    </Tabs.List>
  </div>

  <Tabs.Content value="openai" class="mt-4">
    <KeysTable engine="openai" />
  </Tabs.Content>

  <Tabs.Content value="claude" class="mt-4">
    <KeysTable engine="claude" />
  </Tabs.Content>
</Tabs.Root>

<NewKeyDialog
  bind:open={dialogOpen}
  defaultEngine={dialogEngine}
  onOpenChange={(next) => {
    dialogOpen = next;
    if (!next) clearDialogParam();
  }}
/>
