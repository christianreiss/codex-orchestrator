<script lang="ts">
  /** Every agent address: who can be messaged, whether they are listening, and watchdog recovery. */
  import { toast } from "svelte-sonner";
  import Bot from "@lucide/svelte/icons/bot";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import * as Table from "$lib/components/ui/table";
  import { DataTable } from "$lib/components/page";
  import { authStore } from "$lib/stores/auth";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import {
    agentAddressAliasMutation,
    agentAddressEnabledMutation,
    agentAddressIneligibleReasonLabel,
    agentAddressToggleDisabled,
    agentMessagingAddressesQuery,
    type AgentAdminAddress,
  } from "$lib/api/agentMessaging";
  import ReasonDialog from "./ReasonDialog.svelte";
  import WatchdogPanel from "./WatchdogPanel.svelte";
  import { routeLabel } from "./messaging-labels";

  const addresses = agentMessagingAddressesQuery();
  const addressEnabled = agentAddressEnabledMutation();
  const addressAlias = agentAddressAliasMutation();
  const canMutate = $derived($authStore.can("agent_messaging.manage"));

  let aliasTarget = $state<AgentAdminAddress | null>(null);
  let aliasValue = $state("");

  async function setAddress(address: AgentAdminAddress, enabled: boolean) {
    if (enabled && agentAddressToggleDisabled(address)) {
      toast.error(agentAddressIneligibleReasonLabel(address.ineligible_reason) ?? "Address is not eligible");
      return;
    }
    try {
      await $addressEnabled.mutateAsync({ id: address.id, enabled });
      toast.success(enabled ? "Address enabled" : "Address disabled; related pending work canceled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Address update failed");
    }
  }

  function editAlias(address: AgentAdminAddress) {
    aliasValue = address.alias?.replace(/^agent:/, "") ?? "";
    aliasTarget = address;
  }
  async function saveAlias(value: string) {
    const address = aliasTarget;
    if (!address) return;
    try {
      await $addressAlias.mutateAsync({ id: address.id, alias: value || null });
      toast.success(value ? "Alias updated" : "Alias cleared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Alias update failed");
    } finally {
      aliasTarget = null;
    }
  }
  const presence = (address: AgentAdminAddress) => (address.receiver?.state === "verifying" ? "connecting" : (address.presence ?? "unknown"));
</script>

<section aria-labelledby="addresses-heading" class="space-y-2">
  <div>
    <h2 id="addresses-heading" class="text-h3">Addresses</h2>
    <p class="text-body-sm text-muted-foreground">Created from eligible secure managed sessions. Aliases are optional; the stable address always works. Listening needs a connected receiver.</p>
  </div>
  <DataTable
    items={$addresses.data?.addresses}
    loading={$addresses.isPending}
    error={$addresses.isError ? $addresses.error.message : null}
    onRetry={() => $addresses.refetch()}
    key={(address) => address.id}
    emptyTitle="No agent addresses observed yet"
    emptyIcon={Bot}
    caption="Agent addresses"
  >
    {#snippet head()}
      <Table.Head>Agent</Table.Head>
      <Table.Head>Presence</Table.Head>
      <Table.Head>Host</Table.Head>
      <Table.Head>Last seen</Table.Head>
      <Table.Head class="text-right">Enabled</Table.Head>
    {/snippet}
    {#snippet row(address)}
      {@const ineligibleLabel = agentAddressIneligibleReasonLabel(address.ineligible_reason)}
      <Table.Row class="border-b-0">
        <Table.Cell class="max-w-[20rem]">
          <div class="flex flex-wrap items-center gap-1.5">
            <strong class="truncate font-mono text-body-sm">{routeLabel(address)}</strong>
            <Badge variant="outline" class="uppercase">{address.engine}</Badge>
            {#if !address.eligible}<Badge variant="warning" class="uppercase">Ineligible</Badge>{/if}
          </div>
          <p class="truncate font-mono text-caption text-muted-foreground">{address.address}</p>
          {#if ineligibleLabel}<p class="text-caption text-warning-muted-foreground">{ineligibleLabel}</p>{/if}
        </Table.Cell>
        <Table.Cell>
          <Badge variant={address.presence === "listening" ? "success" : "secondary"} class="uppercase">{presence(address)}</Badge>
          <p class="mt-0.5 text-caption text-muted-foreground">{address.queue_depth ?? 0} queued · {address.continuity}</p>
        </Table.Cell>
        <Table.Cell class="max-w-[16rem]">
          <p class="truncate">{address.fqdn ?? `Host #${address.host_id}`}</p>
          <p class="truncate text-caption text-muted-foreground" title={address.cwd}>{address.username} · {address.host_secure ? "secure" : "insecure"} · {address.host_engines.join(" + ") || "no engines"}</p>
        </Table.Cell>
        <Table.Cell class="text-muted-foreground"><Timestamp value={address.last_seen_at} fallback="Never" /></Table.Cell>
        <Table.Cell>
          <div class="flex items-center justify-end gap-2">
            {#if canMutate}<Button size="sm" variant="outline" onclick={() => editAlias(address)}>Alias</Button>{/if}
            <Switch
              checked={address.enabled}
              disabled={!canMutate || $addressEnabled.isPending || agentAddressToggleDisabled(address)}
              title={!address.enabled && !address.eligible ? (ineligibleLabel ?? undefined) : undefined}
              aria-label={address.enabled
                ? `Disable ${routeLabel(address)}`
                : address.eligible
                  ? `Enable ${routeLabel(address)}`
                  : `Cannot enable ${routeLabel(address)}: ${ineligibleLabel ?? "address is not eligible"}`}
              onCheckedChange={(enabled) => setAddress(address, enabled)}
            />
          </div>
        </Table.Cell>
      </Table.Row>
      <Table.Row>
        <Table.Cell colspan={5} class="p-0">
          <WatchdogPanel target={address.address} canManage={canMutate} eligible={address.eligible && address.continuity === "native"} />
        </Table.Cell>
      </Table.Row>
    {/snippet}
  </DataTable>
</section>

<ReasonDialog
  open={aliasTarget !== null}
  title="Agent alias"
  description="Lowercase letters, digits, dot, underscore or dash. Leave empty to clear it."
  label="Alias"
  bind:value={aliasValue}
  required={false}
  confirmLabel="Save alias"
  busy={$addressAlias.isPending}
  onClose={() => (aliasTarget = null)}
  onConfirm={saveAlias}
/>
