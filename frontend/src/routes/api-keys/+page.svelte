<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import ServerCog from "@lucide/svelte/icons/server-cog";
  import Plus from "@lucide/svelte/icons/plus";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import * as Tabs from "$lib/components/ui/tabs";
  import KillSwitchCard from "$lib/components/api-keys/KillSwitchCard.svelte";
  import KeysTable from "$lib/components/api-keys/KeysTable.svelte";
  import NewKeyDialog from "$lib/components/api-keys/NewKeyDialog.svelte";
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
  title="API access"
  subtitle="Manage compatible endpoints, credentials, rate limits, and per-engine availability."
>
  {#snippet actions()}
    <Button onclick={() => openDialog(activeTab)}>
      <Plus class="h-4 w-4" />
      New key
    </Button>
  {/snippet}
</PageHeader>

<section class="rounded-xl border border-border/75 bg-card p-4 shadow-sm sm:p-5">
  <div class="flex items-start gap-3">
    <ServerCog class="mt-0.5 h-5 w-5 text-muted-foreground" />
    <div class="min-w-0 flex-1">
      <h2 class="text-sm font-semibold tracking-tight">Proxy endpoints</h2>
      <div class="mt-3 grid gap-3 lg:grid-cols-2">
        {#each proxyEndpoints as endpoint}
          <div class="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-background/70 px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <p class="text-sm font-medium">{endpoint.engine}</p>
                <p class="text-xs text-muted-foreground">{endpoint.detail}</p>
              </div>
              <code class="mt-1 block truncate font-mono text-xs text-muted-foreground">
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
      </div>
    </div>
  </div>
</section>

<Tabs.Root class="mt-6" value={activeTab} onValueChange={(v) => (activeTab = v as ApiKeyEngine)}>
  <Tabs.List>
    <Tabs.Trigger value="openai">OpenAI</Tabs.Trigger>
    <Tabs.Trigger value="claude">Anthropic</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="openai" class="space-y-4">
    <KillSwitchCard engine="openai" />
    <KeysTable engine="openai" />
  </Tabs.Content>

  <Tabs.Content value="claude" class="space-y-4">
    <KillSwitchCard engine="claude" />
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
