<script lang="ts">
  /** Search, host, extra type-specific filters, time window and count for the Activity feed. */
  import type { Snippet } from "svelte";
  import { Toolbar } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { filterClass } from "$lib/components/feedback/report-model";
  import type { HostFqdnSummary } from "$lib/api/types";
  import type { ActivityFilters } from "./activity-filters.svelte";
  import { TIME_WINDOWS, parseWindow } from "./event-model";

  type Props = {
    feed: ActivityFilters;
    hosts: HostFqdnSummary[];
    count: string;
    searchLabel: string;
    /** Offer "System (no host)" — only admin changes can have no host. */
    includeSystem?: boolean;
    /** Filters that only apply to one data source (action, status). */
    extra?: Snippet;
  };
  let { feed, hosts, count, searchLabel, includeSystem = false, extra }: Props = $props();

  const hostName = (host: HostFqdnSummary) => host.fqdn || host.hostname || `Host #${host.id}`;
</script>

<Toolbar bind:search={feed.q} searchPlaceholder={searchLabel} {count}>
  {#snippet filters()}
    <select class="{filterClass} w-48" aria-label="Filter by host" bind:value={feed.host}>
      <option value="all">All hosts</option>
      {#if includeSystem}<option value="system">System (no host)</option>{/if}
      {#each hosts as host (host.id)}<option value={String(host.id)}>{hostName(host)}</option>{/each}
    </select>
    {@render extra?.()}
    <select class="{filterClass} w-44" aria-label="Time window" value={feed.window} onchange={(e) => (feed.window = parseWindow(e.currentTarget.value))}>
      {#each TIME_WINDOWS as w (w.value)}<option value={w.value}>{w.label}</option>{/each}
    </select>
  {/snippet}
  {#snippet actions()}
    {#if feed.active}<Button variant="ghost" size="sm" onclick={() => feed.reset()}>Clear filters</Button>{/if}
  {/snippet}
</Toolbar>
