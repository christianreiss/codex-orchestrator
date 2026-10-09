<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import SwitchRow from "$lib/components/settings/SwitchRow.svelte";
  import { agentSessionKeys } from "$lib/api/agentSessions";

  const client = useQueryClient();
  const stateQuery = createQuery({
    queryKey: ["agent-portal", "state"],
    queryFn: () => api.get<{ enabled: boolean; active_sessions: number; queued_messages: number; dead_messages: number }>("/admin/agent-portal/state"),
  });
  let saving = $state(false);
  async function setEnabled(enabled: boolean) {
    saving = true;
    try {
      await api.post("/admin/agent-portal/state", { enabled });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["agent-portal"] }),
        client.invalidateQueries({ queryKey: agentSessionKeys.all }),
      ]);
      toast.success(enabled ? "Agent sessions enabled" : "Agent sessions disabled; pending input cancelled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save session settings");
    } finally { saving = false; }
  }
</script>

<details class="mb-4 rounded-lg border border-border p-3">
  <summary class="cursor-pointer font-semibold">Agent session settings</summary>
  {#if $stateQuery.isError}
    <p role="alert" class="mt-3 text-destructive">{$stateQuery.error.message}</p>
    <button class="mt-2 underline" onclick={() => $stateQuery.refetch()}>Retry settings</button>
  {:else}
    <SwitchRow id="agent-sessions-toggle" label="Agent sessions"
      description="Record sessions and exchange messages through Active Clients and Android. Turning this off cancels pending input."
      checked={$stateQuery.data?.enabled ?? false} disabled={saving || !$stateQuery.data}
      onCheckedChange={setEnabled} />
    {#if $stateQuery.data}
      <p class="mt-2 text-sm text-muted-foreground">{$stateQuery.data.active_sessions ?? 0} active · {$stateQuery.data.queued_messages ?? 0} queued · {$stateQuery.data.dead_messages ?? 0} failed deliveries</p>
    {/if}
  {/if}
</details>
