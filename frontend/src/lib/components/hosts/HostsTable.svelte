<script lang="ts">
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import Server from "@lucide/svelte/icons/server";
  import Plus from "@lucide/svelte/icons/plus";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import { DataTable } from "$lib/components/page";
  import * as Table from "$lib/components/ui/table";
  import { Button } from "$lib/components/ui/button";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import { hostDaemonsQuery } from "$lib/api/hostDaemons";
  import { hostLastSeen, hostStatusKind, isInsecureWindowActive } from "$lib/api/hosts";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import DaemonIndicator from "./DaemonIndicator.svelte";
  import EngineChips from "./EngineChips.svelte";
  import InsecureCountdown from "./InsecureCountdown.svelte";
  import StatusPill from "./StatusPill.svelte";
  import type { HostRow, HostsListState } from "./hostsListState.svelte";

  type Props = {
    state: HostsListState;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    onAdd: () => void;
    onReviewAccess: () => void;
  };
  let { state: list, loading, error, onRetry, onAdd, onReviewAccess }: Props = $props();

  const daemons = hostDaemonsQuery();
  const STATUS = {
    online: { tone: "online", label: "Online" },
    offline: { tone: "offline", label: "Offline" },
    "auth-missing": { tone: "warning", label: "Auth missing" },
  } as const;

  function open(event: MouseEvent, id: number): void {
    // Real links and buttons inside the row keep their own behaviour.
    if ((event.target as HTMLElement).closest("a,button")) return;
    void goto(`${base}/hosts/${id}`);
  }
</script>

<DataTable
  items={list.rows}
  {loading}
  {error}
  {onRetry}
  key={(row: HostRow) => row.host.id}
  filtered={list.filtered && list.all.length > 0}
  emptyTitle="No hosts yet"
  emptyDescription="Add a host to start routing work through it."
  emptyIcon={Server}
  caption="Hosts"
>
  {#snippet emptyAction()}
    <Button size="sm" onclick={onAdd}><Plus class="h-4 w-4" /> Add host</Button>
  {/snippet}
  {#snippet head()}
    <SortableHead label="Name" active={list.sortField === "fqdn"} dir={list.sortDir} onclick={() => list.setSort("fqdn")} />
    <Table.Head>Status</Table.Head>
    <SortableHead label="Needs attention" active={list.sortField === "attention"} dir={list.sortDir} onclick={() => list.setSort("attention")} />
    <Table.Head>Engines</Table.Head>
    <SortableHead label="Last contact" active={list.sortField === "last_refresh"} dir={list.sortDir} onclick={() => list.setSort("last_refresh")} />
  {/snippet}
  {#snippet row({ host, items }: HostRow)}
    {@const kind = hostStatusKind(host, list.now)}
    {@const warnings = items.filter((item) => item.tone === "warning")}
    <Table.Row class="cursor-pointer" onclick={(event: MouseEvent) => open(event, host.id)} data-host-id={host.id}>
      <Table.Cell class="max-w-[16rem]">
        <a href={`${base}/hosts/${host.id}`} class="block truncate font-medium hover:underline">{host.fqdn}</a>
        <span class="block truncate font-mono text-caption text-muted-foreground">{host.ip4 ?? host.ip6 ?? "no address"} · #{host.id}</span>
        <span class="block truncate text-caption text-muted-foreground sm:hidden">Seen <Timestamp value={hostLastSeen(host)} fallback="never" /></span>
      </Table.Cell>
      <Table.Cell>
        <span class="inline-flex flex-wrap items-center gap-1.5">
          <StatusPill tone={STATUS[kind].tone} label={STATUS[kind].label} />
          {#if isInsecureWindowActive(host)}<span title="Temporary access is open"><InsecureCountdown until={host.insecure_enabled_until} /></span>{/if}
        </span>
      </Table.Cell>
      <Table.Cell class="max-w-[22rem]">
        {#if warnings.length === 0}
          <span class="text-muted-foreground">Nothing</span>
        {:else}
          <span class="flex items-center gap-2">
            <span class="truncate" title={warnings.map((w) => w.text).join("\n")}>{warnings[0].text}</span>
            {#if warnings.length > 1}<span class="shrink-0 text-caption text-muted-foreground">+{warnings.length - 1} more</span>{/if}
            {#if warnings.some((w) => w.fix === "review-access")}
              <Button size="sm" variant="outline" onclick={onReviewAccess}><ShieldAlert class="h-4 w-4" /> Review</Button>
            {/if}
          </span>
        {/if}
      </Table.Cell>
      <Table.Cell>
        <span class="flex flex-wrap items-center gap-2">
          <EngineChips {host} />
          <DaemonIndicator host={$daemons.data?.hosts.find((d) => d.host_id === host.id)} />
        </span>
      </Table.Cell>
      <Table.Cell class="whitespace-nowrap text-muted-foreground">
        <Timestamp value={hostLastSeen(host)} fallback="Never" />
      </Table.Cell>
    </Table.Row>
  {/snippet}
</DataTable>
