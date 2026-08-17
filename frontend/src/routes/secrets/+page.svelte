<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import ModuleSwitchRow from "$lib/components/layout/ModuleSwitchRow.svelte";
  import SecretsTable from "$lib/components/secrets/SecretsTable.svelte";
  import NewSecretDialog from "$lib/components/secrets/NewSecretDialog.svelte";
  import { secretsApi, secretQueryKeys } from "$lib/api/secrets";
  import type { AdminSecret, AdminSecretsModuleState } from "$lib/api/types";
  import { authStore } from "$lib/stores/auth";

  const canManage = $derived($authStore.can("secrets.manage"));

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

  const qc = useQueryClient();
  const stateKey = secretQueryKeys.state();

  const stateQuery = createQuery<AdminSecretsModuleState>({
    queryKey: stateKey,
    queryFn: () => secretsApi.getState(),
  });

  const toggleMutation = createMutation<
    AdminSecretsModuleState,
    Error,
    boolean,
    { previous?: AdminSecretsModuleState }
  >({
    mutationFn: (next) => secretsApi.setState(next),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: stateKey });
      const previous = qc.getQueryData<AdminSecretsModuleState>(stateKey);
      qc.setQueryData<AdminSecretsModuleState>(stateKey, (current) =>
        current ? { ...current, enabled: next } : current,
      );
      return { previous };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(stateKey, ctx.previous);
      toast.error("Could not change the secrets module", { description: err.message });
    },
    onSuccess: (data) => {
      toast.success(data.enabled ? "Secrets store enabled" : "Secrets store disabled", {
        description: data.enabled
          ? "Agents can read secrets over MCP. Each host picks up the guidance on its next sync."
          : "secret_get now refuses every host until this is switched back on.",
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: stateKey });
    },
  });

  const moduleState = $derived($stateQuery.data);
  const moduleEnabled = $derived(moduleState?.enabled ?? false);
  const moduleCount = $derived(moduleState?.count ?? 0);
</script>

<PageHeader
  title="Secrets"
  subtitle="Working credentials your agents fetch over MCP — not the sign-in that starts them."
/>

<div class="space-y-6">
  <ModuleSwitchRow
    id="secrets-enabled"
    label="Fleet secrets store"
    description={moduleEnabled
      ? "Module is enabled. Agents can read secrets over MCP."
      : "Module is disabled. secret_get refuses every host until this is switched back on."}
    checked={moduleEnabled}
    disabled={!canManage || $stateQuery.isLoading || $toggleMutation.isPending}
    onCheckedChange={(next) => $toggleMutation.mutate(next)}
  >
    {#snippet notice()}
      {#if moduleEnabled && moduleCount === 0}
        <p class="flex items-start gap-2 text-xs text-warning-muted-foreground">
          <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          The module is on but holds no secrets, so nothing is served and no guidance is added to any
          host's AGENTS.md. Add a secret below to make it useful.
        </p>
      {:else if moduleEnabled}
        <p class="text-xs text-muted-foreground">
          Each host gains a managed <span class="font-medium">## Secrets</span> section in its
          AGENTS.md / CLAUDE.md on the next sync, telling agents to look here before asking a human
          or hunting through config files.
        </p>
      {:else}
        <p class="text-xs text-muted-foreground">
          While this is off, <code class="font-mono">secret_list</code> returns nothing. You can still
          add secrets below and switch the store on afterwards.
        </p>
      {/if}
    {/snippet}
  </ModuleSwitchRow>

  <SecretsTable onEdit={openEdit} onCreate={openCreate} />

  <p class="text-sm text-muted-foreground">
    Values are encrypted at rest and delivered only over MCP — nothing is ever written to a host's
    filesystem, which is why revoking works on the next read with no host cleanup. Note that a
    secret an agent has read is in that agent's transcript: the protection boundary is this
    database and the wire, not the conversation.
  </p>
</div>

<NewSecretDialog bind:open={dialogOpen} {editing} onOpenChange={(v) => (dialogOpen = v)} />
