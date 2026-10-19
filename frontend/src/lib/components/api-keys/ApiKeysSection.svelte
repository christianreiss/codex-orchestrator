<script lang="ts">
  /** API keys: one key list first; routing and availability behind "Configure". */
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { tick } from "svelte";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Section } from "$lib/components/page";
  import { apiStateQuery } from "$lib/api/settings";
  import type { ApiKeyEngine } from "$lib/api/types";
  import KeysList from "./KeysList.svelte";
  import NewKeyDialog from "./NewKeyDialog.svelte";
  import ApiConfigure from "./ApiConfigure.svelte";

  const CONFIG_ANCHORS = new Set(["configuration", "service-availability", "api-state", "exposed-apis", "backend-settings", "claude-proxy", "claude-engine", "grok-proxy", "grok-engine"]);

  const apiState = apiStateQuery();
  let vendor = $state<ApiKeyEngine | "all">("all");
  let configOpen = $state(false);
  let claudeOpen = $state(false);
  let grokOpen = $state(false);
  let dialogOpen = $state(false);
  let dialogEngine = $state<ApiKeyEngine>("openai");

  function openDialog(engine?: ApiKeyEngine) {
    dialogEngine = engine ?? (vendor === "all" ? "openai" : vendor);
    dialogOpen = true;
  }

  function showKeys(next: ApiKeyEngine) {
    vendor = next;
    void tick().then(() => document.getElementById("api-keys")?.scrollIntoView({ block: "start" }));
  }

  // Legacy anchors (#service-availability, #claude-proxy, ...) open the panel, then scroll to the target.
  $effect(() => {
    const anchor = page.url.hash.slice(1);
    if (!CONFIG_ANCHORS.has(anchor)) return;
    configOpen = true;
    if (anchor === "claude-proxy" || anchor === "claude-engine") claudeOpen = true;
    if (anchor === "grok-proxy" || anchor === "grok-engine") grokOpen = true;
    void tick().then(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
  });

  // `?dialog=new&engine=…` deep link.
  $effect(() => {
    if (page.url.searchParams.get("dialog") !== "new") return;
    const requested = page.url.searchParams.get("engine");
    const engine: ApiKeyEngine = requested === "grok" ? "grok" : requested === "claude" ? "claude" : "openai";
    if (requested === "grok" || requested === "claude" || requested === "openai") vendor = engine;
    openDialog(engine);
  });

  function clearDialogParam(): void {
    if (page.url.searchParams.get("dialog") !== "new") return;
    const url = new URL(page.url);
    url.searchParams.delete("dialog");
    url.searchParams.delete("engine");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }
</script>

<Collapsible.Root bind:open={configOpen}>
  <Section id="api-keys" title="API keys" hideTitle>
    {#snippet actions()}
      <Collapsible.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="sm">
            <Settings2 class="h-4 w-4" />Configure
          </Button>
        {/snippet}
      </Collapsible.Trigger>
    {/snippet}

    <div class="space-y-3">
      {#if $apiState.data?.disabled}
        <p role="status" class="text-body-sm text-warning">All API traffic is disabled. Open Configure to restore access.</p>
      {/if}

      <Collapsible.Content>
        <h3 class="mb-2 text-h3">Service availability &amp; routing</h3>
        <ApiConfigure onShowKeys={showKeys} bind:claudeOpen bind:grokOpen />
      </Collapsible.Content>

      <KeysList bind:vendor onCreate={() => openDialog()} />
    </div>
  </Section>
</Collapsible.Root>

<NewKeyDialog
  bind:open={dialogOpen}
  defaultEngine={dialogEngine}
  onOpenChange={(next) => {
    dialogOpen = next;
    if (!next) clearDialogParam();
  }}
/>
