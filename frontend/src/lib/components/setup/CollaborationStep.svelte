<script lang="ts">
  /**
   * The two collaboration surfaces, both deliberately off on a fresh install.
   *
   * These are the only switches in the wizard where "off" is a security posture
   * rather than an unset value, so both spell out what turning them on actually
   * does rather than offering a bare toggle.
   */
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import ModuleSwitchRow from "$lib/components/layout/ModuleSwitchRow.svelte";
  import StepQueryState from "./StepQueryState.svelte";

  type PortalState = { enabled: boolean; configured?: boolean };
  type MessagingState = { enabled: boolean };

  const qc = useQueryClient();

  const portal = createQuery({
    queryKey: ["agent-portal", "state"],
    queryFn: () => api.get<PortalState>("/admin/agent-portal/state"),
  });
  const messaging = createQuery({
    queryKey: ["agent-messaging", "state"],
    queryFn: () => api.get<MessagingState>("/admin/agent-messaging/state"),
  });

  let portalOn = $state(false);
  let messagingOn = $state(false);
  let saving = $state(false);
  let portalLoaded = $state(false);
  let messagingLoaded = $state(false);

  const loading = $derived($portal.isLoading || $messaging.isLoading);
  const loadError = $derived($portal.error?.message ?? $messaging.error?.message ?? null);
  $effect(() => {
    const value = $portal.data?.enabled;
    if (!portalLoaded && typeof value === "boolean") {
      portalOn = value;
      portalLoaded = true;
    }
  });
  $effect(() => {
    const value = $messaging.data?.enabled;
    if (!messagingLoaded && typeof value === "boolean") {
      messagingOn = value;
      messagingLoaded = true;
    }
  });

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return saving;
  }

  /** Footer label. */
  export function primaryLabel(): string {
    return "Save and continue";
  }

  export async function persist(): Promise<boolean> {
    saving = true;
    try {
      // Unloaded state is never written; see ModulesStep.
      if (portalLoaded && portalOn !== ($portal.data?.enabled ?? false)) {
        await api.post("/admin/agent-portal/state", { enabled: portalOn });
        void qc.invalidateQueries({ queryKey: ["agent-portal"] });
      }
      if (messagingLoaded && messagingOn !== ($messaging.data?.enabled ?? false)) {
        await api.post("/admin/agent-messaging/state", { enabled: messagingOn });
        void qc.invalidateQueries({ queryKey: ["agent-messaging"] });
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save collaboration settings");
      return false;
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-3">
  {#if loading || loadError}
    <StepQueryState
      {loading}
      error={loadError}
      subject="collaboration settings"
      onRetry={() => {
        void $portal.refetch();
        void $messaging.refetch();
      }}
    />
  {:else}
    <ModuleSwitchRow
      id="setup-portal"
      class="rounded-lg border"
      label="Agent sessions"
      description="Record running agents and exchange messages through Active Clients and the Android app. Operator text remains ordinary user input with existing permission boundaries."
      checked={portalOn}
      onCheckedChange={(v) => (portalOn = v)}
    />
    <ModuleSwitchRow
      id="setup-messaging"
      class="rounded-lg border"
      label="Agent Messaging"
      description="Lets agents on different hosts message each other. One fleet-wide switch: turning it on enables the bus for every active host, insecure ones included, and adds an Agent Messaging section to every host's AGENTS.md / CLAUDE.md. Peer text is treated as ordinary model input, never as authorization."
      checked={messagingOn}
      onCheckedChange={(v) => (messagingOn = v)}
    />
  {/if}
</div>
