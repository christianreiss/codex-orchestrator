<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import SecretsModuleCard from "$lib/components/secrets/SecretsModuleCard.svelte";
  import SecretsTable from "$lib/components/secrets/SecretsTable.svelte";
  import NewSecretDialog from "$lib/components/secrets/NewSecretDialog.svelte";
  import type { AdminSecret } from "$lib/api/types";

  let dialogOpen = $state(false);
  let editing = $state<AdminSecret | null>(null);

  function openCreate() {
    editing = null;
    dialogOpen = true;
  }

  function openEdit(secret: AdminSecret) {
    editing = secret;
    dialogOpen = true;
  }
</script>

<PageHeader
  title="Secrets"
  subtitle="Working credentials your agents fetch over MCP — not the sign-in that starts them."
>
  {#snippet actions()}
    <Button onclick={openCreate}>
      <Plus class="h-4 w-4" />
      New secret
    </Button>
  {/snippet}
</PageHeader>

<div class="space-y-6">
  <SecretsModuleCard />

  <SecretsTable onEdit={openEdit} />

  <p class="text-sm text-muted-foreground">
    Values are encrypted at rest and delivered only over MCP — nothing is ever written to a host's
    filesystem, which is why revoking works on the next read with no host cleanup. Note that a
    secret an agent has read is in that agent's transcript: the protection boundary is this
    database and the wire, not the conversation.
  </p>
</div>
