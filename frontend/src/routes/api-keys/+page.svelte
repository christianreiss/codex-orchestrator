<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Tabs from "$lib/components/ui/tabs";
  import KillSwitchCard from "$lib/components/api-keys/KillSwitchCard.svelte";
  import KeysTable from "$lib/components/api-keys/KeysTable.svelte";
  import NewKeyDialog from "$lib/components/api-keys/NewKeyDialog.svelte";
  import type { ApiKeyEngine } from "$lib/api/types";

  let dialogOpen = $state(false);
  let dialogEngine = $state<ApiKeyEngine>("openai");
  let activeTab = $state<ApiKeyEngine>("openai");

  function openDialog(engine: ApiKeyEngine) {
    dialogEngine = engine;
    dialogOpen = true;
  }
</script>

<PageHeader title="API Keys" subtitle="Issue and revoke programmatic access">
  {#snippet actions()}
    <Button onclick={() => openDialog(activeTab)}>
      <Plus class="h-4 w-4" />
      New key
    </Button>
  {/snippet}
</PageHeader>

<Tabs.Root value={activeTab} onValueChange={(v) => (activeTab = v as ApiKeyEngine)}>
  <Tabs.List>
    <Tabs.Trigger value="openai">OpenAI</Tabs.Trigger>
    <Tabs.Trigger value="claude">Claude</Tabs.Trigger>
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

<NewKeyDialog bind:open={dialogOpen} defaultEngine={dialogEngine} />
