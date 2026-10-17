<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import PolicyRow from "$lib/components/policies/PolicyRow.svelte";
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

<PolicyRow
  id="agent-sessions"
  controlId="agent-sessions-toggle"
  label="Agent sessions"
  term="agent portal"
  help="Record sessions and let operators talk to agents from the console and Android. Turning this off cancels pending input."
>
  {#snippet control()}
    <Switch id="agent-sessions-toggle" checked={$stateQuery.data?.enabled ?? false} disabled={saving || !$stateQuery.data} onCheckedChange={setEnabled} />
  {/snippet}
  {#if $stateQuery.isError}
    <p role="alert" class="text-body-sm text-destructive">{$stateQuery.error.message}</p>
    <Button variant="outline" size="sm" class="mt-1" onclick={() => $stateQuery.refetch()}>Retry loading</Button>
  {:else if $stateQuery.data}
    <p class="text-body-sm text-muted-foreground">{$stateQuery.data.active_sessions ?? 0} active · {$stateQuery.data.queued_messages ?? 0} queued · {$stateQuery.data.dead_messages ?? 0} failed deliveries</p>
  {/if}
</PolicyRow>
