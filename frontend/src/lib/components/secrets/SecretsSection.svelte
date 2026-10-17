<script lang="ts">
  /** Secrets: the list first; the module switch lives in the section header. */
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Switch } from "$lib/components/ui/switch";
  import { Section } from "$lib/components/page";
  import SecretsList from "./SecretsList.svelte";
  import NewSecretDialog from "./NewSecretDialog.svelte";
  import { secretsApi, secretQueryKeys } from "$lib/api/secrets";
  import type { AdminSecret, AdminSecretsModuleState } from "$lib/api/types";
  import { authStore } from "$lib/stores/auth";

  const canManage = $derived($authStore.can("secrets.manage"));

  let dialogOpen = $state(false);
  let editing = $state<AdminSecret | null>(null);
  function openCreate() { editing = null; dialogOpen = true; }
  function openEdit(secret: AdminSecret) { editing = secret; dialogOpen = true; }

  const qc = useQueryClient();
  const stateKey = secretQueryKeys.state();
  const stateQuery = createQuery<AdminSecretsModuleState>({ queryKey: stateKey, queryFn: () => secretsApi.getState() });

  const toggleMutation = createMutation<AdminSecretsModuleState, Error, boolean, { previous?: AdminSecretsModuleState }>({
    mutationFn: (next) => secretsApi.setState(next),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: stateKey });
      const previous = qc.getQueryData<AdminSecretsModuleState>(stateKey);
      qc.setQueryData<AdminSecretsModuleState>(stateKey, (current) => (current ? { ...current, enabled: next } : current));
      return { previous };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(stateKey, ctx.previous);
      toast.error("Could not change the secrets store", { description: err.message });
    },
    onSuccess: (data) => {
      toast.success(data.enabled ? "Secrets store enabled" : "Secrets store disabled", {
        description: data.enabled
          ? "Agents can read secrets over MCP. Each host picks up the guidance on its next sync."
          : "secret_get now refuses every host until this is switched back on.",
      });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: stateKey }),
  });

  const moduleState = $derived($stateQuery.data);
  const enabled = $derived(moduleState?.enabled ?? false);
  const count = $derived(moduleState?.count ?? 0);
</script>

<Section id="secrets" title="Secrets" description="Working credentials shared by Codex, Claude and Grok over MCP.">
  {#snippet actions()}
    <label class="flex items-center gap-2 text-body-sm text-muted-foreground">
      Store enabled
      <Switch
        id="secrets-enabled"
        checked={enabled}
        disabled={!canManage || $stateQuery.isLoading || $toggleMutation.isPending}
        onCheckedChange={(next) => $toggleMutation.mutate(next)}
        aria-label="Fleet secrets store"
      />
    </label>
  {/snippet}

  <div class="space-y-3">
    <SecretsList onEdit={openEdit} onCreate={openCreate} />

    {#if moduleState && !enabled}
      <p role="status" class="text-body-sm text-warning">The store is off, so <code class="font-mono">secret_list</code> returns nothing and <code class="font-mono">secret_get</code> refuses every host. You can still add secrets and switch it on afterwards.</p>
    {:else if moduleState && count === 0}
      <p role="status" class="text-body-sm text-warning">The store is on but holds no secrets, so no guidance is added to any host. Add a secret to make it useful.</p>
    {/if}

    <div class="text-body-sm text-muted-foreground">
      Values are encrypted at rest and only ever delivered over MCP.
      <details class="mt-1 inline-block align-top">
        <summary class="cursor-pointer text-primary underline-offset-4 hover:underline">Learn more</summary>
        <span class="mt-1 block max-w-prose">
          Nothing is written to a host's filesystem, which is why revoking works on the next read with no host cleanup. A secret an agent has read is in that agent's transcript: the protection boundary is this database and the wire, not the conversation.
          While the store is on, each host gains a managed <span class="font-medium">## Secrets</span> section in its AGENTS.md / CLAUDE.md on the next sync, telling agents to look here before asking a human.
        </span>
      </details>
    </div>
  </div>
</Section>

<NewSecretDialog bind:open={dialogOpen} {editing} onOpenChange={(v) => (dialogOpen = v)} />
