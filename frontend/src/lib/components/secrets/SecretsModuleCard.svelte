<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import * as Card from "$lib/components/ui/card";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { secretsApi, secretQueryKeys } from "$lib/api/secrets";
  import type { AdminSecretsModuleState } from "$lib/api/types";

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
    mutationFn: (enabled) => secretsApi.setState(enabled),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: stateKey });
      const previous = qc.getQueryData<AdminSecretsModuleState>(stateKey);
      qc.setQueryData<AdminSecretsModuleState>(stateKey, (current) =>
        current ? { ...current, enabled } : current,
      );
      return { previous };
    },
    onError: (err, _enabled, ctx) => {
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

  const state = $derived($stateQuery.data);
  const enabled = $derived(state?.enabled ?? false);
  const count = $derived(state?.count ?? 0);
</script>

<Card.Root>
  <Card.Header>
    <div class="flex items-start justify-between gap-4">
      <div class="space-y-1">
        <Card.Title class="flex items-center gap-2">
          <ShieldCheck class="h-5 w-5 text-muted-foreground" />
          Fleet secrets store
        </Card.Title>
        <Card.Description>
          Working credentials agents read over MCP. Values are encrypted at rest and never
          written to a host's disk, so revoking one takes effect on its next read.
        </Card.Description>
      </div>
      {#if $stateQuery.isLoading}
        <Skeleton class="h-6 w-11 rounded-full" />
      {:else}
        <Switch
          aria-label="Enable the fleet secrets store"
          checked={enabled}
          disabled={$toggleMutation.isPending}
          onCheckedChange={(v) => $toggleMutation.mutate(v)}
        />
      {/if}
    </div>
  </Card.Header>
  <Card.Content class="space-y-3">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant={enabled ? "default" : "secondary"}>
        {enabled ? "Enabled" : "Disabled"}
      </Badge>
      <span class="text-muted-foreground">
        {count}
        {count === 1 ? "secret" : "secrets"} available to agents
      </span>
    </div>

    {#if !enabled}
      <p class="text-sm text-muted-foreground">
        While this is off, <code class="font-mono text-xs">secret_list</code> returns nothing and
        <code class="font-mono text-xs">secret_get</code> refuses every host. You can still add
        secrets below and switch the store on afterwards.
      </p>
    {:else if count === 0}
      <div
        class="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
      >
        <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          The module is on but holds no secrets, so nothing is served and no guidance is added to
          any host's AGENTS.md. Add a secret to make it useful.
        </p>
      </div>
    {:else}
      <p class="text-sm text-muted-foreground">
        Each host gains a managed <span class="font-medium">## Secrets</span> section in its
        AGENTS.md / CLAUDE.md on the next sync, telling agents to look here before asking a human
        or hunting through config files.
      </p>
    {/if}
  </Card.Content>
</Card.Root>
