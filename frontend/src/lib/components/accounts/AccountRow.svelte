<script lang="ts">
  import { base } from "$app/paths";
  import * as Table from "$lib/components/ui/table";
  import RowActions, { type RowAction } from "$lib/components/data-table/RowActions.svelte";
  import { ENGINE_META } from "$lib/constants/engines";
  import { fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import type { ProviderAccount } from "$lib/api/accounts";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { cn } from "$lib/utils/cn";
  import AccountUsage from "./AccountUsage.svelte";
  import { accountStatus, sessionHosts } from "./account-state";

  type Props = {
    account: ProviderAccount;
    engineOn: boolean;
    canManage: boolean;
    busy: boolean;
    onQuota: () => void;
    onRename: () => void;
    onReplace: () => void;
    onVerify: () => void;
    onToggle: () => void;
    onRemove: () => void;
  };
  let { account, engineOn, canManage, busy, onQuota, onRename, onReplace, onVerify, onToggle, onRemove }: Props = $props();

  const meta = $derived(ENGINE_META[account.engine]);
  const status = $derived(accountStatus(account, engineOn, meta.command));
  const hosts = $derived(sessionHosts(account));
  const runnerTask = $derived(account.sessions.some((session) => session.host_id === 0));
  const dot = { ok: "bg-success", warning: "bg-warning", danger: "bg-destructive", muted: "bg-muted-foreground/40" } as const;
  const textTone = { ok: "text-muted-foreground", warning: "text-warning-muted-foreground", danger: "text-destructive", muted: "text-muted-foreground" } as const;
  const offReason = $derived(engineOn ? undefined : fleetDisabledTitle(meta.label));
  const actions = $derived<RowAction[]>([
    { label: "Quota policy", onClick: onQuota },
    { label: "Rename", onClick: onRename },
    { label: "Replace credentials", onClick: onReplace, disabled: !engineOn, reason: offReason },
    { label: "Verify", onClick: onVerify, disabled: busy || !engineOn, reason: offReason },
    { label: account.state === "enabled" ? "Pause" : "Resume", onClick: onToggle, disabled: busy },
    { label: "Remove", onClick: onRemove, destructive: true, disabled: busy },
  ]);
</script>

<Table.Row>
  <Table.Cell class="min-w-56">
    <div class="flex items-start gap-2">
      <span class={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dot[status.tone])} aria-hidden="true"></span>
      <div class="min-w-0">
        <div class="truncate font-medium" title={`Account #${account.id}`}>{account.label}</div>
        <div class={cn("text-caption", textTone[status.tone])}>
          <span class={status.tone === "danger" ? "font-medium" : ""}>{status.label}</span>{#if status.detail}<span class="text-muted-foreground">{" · "}{status.detail}</span>{/if}
        </div>
      </div>
    </div>
  </Table.Cell>
  <Table.Cell class="whitespace-nowrap text-body-sm">
    <span class="inline-flex items-center gap-1.5"><span class={cn("h-2 w-2 rounded-full", meta.color)} aria-hidden="true"></span>{meta.account}</span>
    {#if account.quota_policy?.unlimited}<div class="text-caption text-muted-foreground">PayG / unlimited</div>{/if}
    {#if account.plan?.name}<div class="text-caption text-muted-foreground">{account.plan.name}</div>{/if}
  </Table.Cell>
  <Table.Cell><AccountUsage {account} /></Table.Cell>
  <Table.Cell class="whitespace-nowrap text-body-sm">
    {account.sessions.length}
    {#if hosts.length || runnerTask}
      <div class="flex flex-wrap gap-x-2 text-caption">
        {#if runnerTask}<span class="text-muted-foreground">Runner task</span>{/if}
        {#each hosts as hostId (hostId)}<a class="text-primary underline-offset-2 hover:underline" href={`${base}/hosts/${hostId}`}>Host #{hostId}</a>{/each}
      </div>
    {/if}
  </Table.Cell>
  <Table.Cell class="whitespace-nowrap text-body-sm text-muted-foreground" ><Timestamp value={account.verification_checked_at} fallback="Never" /></Table.Cell>
  <Table.Cell class="w-10 text-right">
    {#if canManage && account.state !== "removing"}<RowActions {actions} label={`Actions for ${account.label}`} />{/if}
  </Table.Cell>
</Table.Row>
