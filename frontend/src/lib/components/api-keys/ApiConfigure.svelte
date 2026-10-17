<script lang="ts">
  /**
   * "Service availability & routing": which engine answers each API, the
   * per-backend defaults and the global kill switch. Opened from the key list's
   * Configure button; every anchor from the old API Access page still lands here.
   */
  import ExposedApisTable from "./ExposedApisTable.svelte";
  import ApiStateSection from "$lib/components/settings/ApiStateSection.svelte";
  import GrokEngineSection from "$lib/components/settings/GrokEngineSection.svelte";
  import ClaudeEngineSection from "$lib/components/settings/ClaudeEngineSection.svelte";
  import type { ApiKeyEngine } from "$lib/api/types";

  type Props = {
    onShowKeys?: (vendor: ApiKeyEngine) => void;
    claudeOpen?: boolean;
    grokOpen?: boolean;
  };
  let { onShowKeys, claudeOpen = $bindable(false), grokOpen = $bindable(false) }: Props = $props();
</script>

<div id="configuration" class="scroll-mt-20 space-y-5 rounded-md border p-4">
  <section id="exposed-apis" class="scroll-mt-20 space-y-2">
    <h4 class="text-body font-medium">Routing</h4>
    <p class="text-body-sm text-muted-foreground">Turn an API on or off and choose the engine that answers it by default.</p>
    <ExposedApisTable {onShowKeys} />
  </section>

  <section id="backend-settings" class="scroll-mt-20 border-t pt-4">
    <h4 class="text-body font-medium">Backend defaults</h4>
    <details id="claude-proxy" bind:open={claudeOpen} class="scroll-mt-20 border-b">
      <summary class="cursor-pointer py-3 text-body">Claude <span class="ml-2 text-caption text-muted-foreground">Model &amp; token limit</span></summary>
      <ClaudeEngineSection />
    </details>
    <details id="grok-proxy" bind:open={grokOpen} class="scroll-mt-20 border-b">
      <summary class="cursor-pointer py-3 text-body">Grok <span class="ml-2 text-caption text-muted-foreground">Default model &amp; available models</span></summary>
      <GrokEngineSection />
    </details>
  </section>

  <section id="service-availability" class="scroll-mt-20 border-t pt-4">
    <h4 class="text-body font-medium">All API traffic</h4>
    <ApiStateSection bordered={false} />
  </section>
</div>
