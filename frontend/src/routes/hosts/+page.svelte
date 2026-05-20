<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { useQueryClient } from "@tanstack/svelte-query";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import Plus from "@lucide/svelte/icons/plus";
  import Rocket from "@lucide/svelte/icons/rocket";
  import Search from "@lucide/svelte/icons/search";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import {
    hostsListQuery,
    hostMatchesFilter,
    createAutoUpdateToggleMutation,
    type HostFilterId,
  } from "$lib/api/hosts";
  import HostsTable from "$lib/components/hosts/HostsTable.svelte";
  import FilterChips from "$lib/components/hosts/FilterChips.svelte";
  import NewHostSheet from "$lib/components/hosts/NewHostSheet.svelte";
  import QuickVmDialog from "$lib/components/hosts/QuickVmDialog.svelte";
  import InsecureApprovalsDialog from "$lib/components/hosts/InsecureApprovalsDialog.svelte";
  import SeedAuthDialog from "$lib/components/hosts/SeedAuthDialog.svelte";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import { hostsSummary } from "$lib/stores/hosts-summary";
  import { isInsecureWindowActive } from "$lib/api/hosts";
  import { toast } from "svelte-sonner";
  import type { HostListItem } from "$lib/api/types";

  const qc = useQueryClient();
  const hosts = hostsListQuery();
  const autoUpdate = createAutoUpdateToggleMutation(qc);

  // --- URL-synced filter --------------------------------------------------
  const VALID: HostFilterId[] = [
    "all",
    "online",
    "offline",
    "secure",
    "insecure",
    "unprovisioned",
    "vip",
    "roaming",
  ];

  const filter = $derived.by<HostFilterId>(() => {
    const f = page.url.searchParams.get("filter") ?? "all";
    return (VALID as string[]).includes(f) ? (f as HostFilterId) : "all";
  });

  function setFilter(value: HostFilterId): void {
    const url = new URL(page.url);
    if (value === "all") url.searchParams.delete("filter");
    else url.searchParams.set("filter", value);
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  // --- search (debounced) -------------------------------------------------
  let searchInput = $state("");
  let searchDebounced = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    // run on every change of searchInput
    const v = searchInput;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchDebounced = v.trim().toLowerCase();
    }, 200);
  });

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  // --- derived data -------------------------------------------------------
  const allRows = $derived(($hosts.data?.hosts ?? []) as HostListItem[]);

  const counts = $derived.by<Partial<Record<HostFilterId, number>>>(() => {
    const result: Partial<Record<HostFilterId, number>> = {};
    for (const id of VALID) result[id] = 0;
    for (const r of allRows) {
      for (const id of VALID) {
        if (hostMatchesFilter(r, id)) result[id] = (result[id] ?? 0) + 1;
      }
    }
    return result;
  });

  const filtered = $derived.by<HostListItem[]>(() => {
    let list = allRows.filter((h) => hostMatchesFilter(h, filter));
    if (searchDebounced) {
      const q = searchDebounced;
      list = list.filter((h) => {
        const fqdn = (h.fqdn ?? "").toLowerCase();
        const ver = (h.client_version ?? "").toLowerCase();
        const claudeVer = (h.claude_client_version ?? "").toLowerCase();
        const status = (h.status ?? "").toLowerCase();
        return (
          fqdn.includes(q) || ver.includes(q) || claudeVer.includes(q) || status.includes(q)
        );
      });
    }
    return list;
  });

  // --- sync active windows badge -----------------------------------------
  $effect(() => {
    const activeWindows = allRows.filter((h) => isInsecureWindowActive(h)).length;
    hostsSummary.setActiveInsecureWindows(activeWindows);
  });

  onMount(() => {
    // Initial sync
  });

  // --- sheets / dialogs ---------------------------------------------------
  let newOpen = $state(false);
  let quickOpen = $state(false);
  let insecureOpen = $state(false);
  let seedOpen = $state(false);

  // /hosts/new path opens the sheet on landing
  $effect(() => {
    if (page.url.pathname.replace(base, "") === "/hosts/new") {
      newOpen = true;
    }
  });

  $effect(() => {
    if (page.url.searchParams.get("insecure") === "1") {
      insecureOpen = true;
    }
  });

  async function handleAutoUpdate(h: HostListItem, value: boolean): Promise<void> {
    try {
      await $autoUpdate.mutateAsync({ id: h.id, value });
      toast.success(`Auto-update ${value ? "enabled" : "disabled"} for ${h.fqdn}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      toast.error(msg);
    }
  }
</script>

<PageHeader title="Hosts" subtitle="All connected machines and their installer state.">
  {#snippet actions()}
    <Button variant="outline" onclick={() => (insecureOpen = true)}>
      <ShieldAlert class="h-4 w-4" /> Insecure
      {#if ($hostsSummary.activeInsecureWindows ?? 0) > 0}
        <span class="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
          {$hostsSummary.activeInsecureWindows}
        </span>
      {/if}
    </Button>
    <Button variant="outline" onclick={() => (seedOpen = true)}>
      <KeyRound class="h-4 w-4" /> Seed auth
    </Button>
    <Button variant="secondary" onclick={() => (quickOpen = true)}>
      <Rocket class="h-4 w-4" /> Quick VM
    </Button>
    <Button onclick={() => (newOpen = true)}>
      <Plus class="h-4 w-4" /> New host
    </Button>
  {/snippet}
</PageHeader>

<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <FilterChips value={filter} {counts} onchange={setFilter} />
  <label class="relative block sm:w-72">
    <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    <Input
      class="pl-8"
      placeholder="Search hostname, status, version…"
      bind:value={searchInput}
      aria-label="Search hosts"
    />
  </label>
</div>

{#if $hosts.isLoading}
  <div class="space-y-2">
    {#each Array(6) as _, i (i)}
      <Skeleton class="h-12 w-full rounded-md" />
    {/each}
  </div>
{:else if $hosts.isError}
  <div class="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
    Failed to load hosts: {$hosts.error?.message ?? "unknown error"}
  </div>
{:else}
  <HostsTable rows={filtered} loading={$hosts.isFetching} onToggleAutoUpdate={handleAutoUpdate} />
{/if}

<NewHostSheet
  bind:open={newOpen}
  onOpenChange={(o) => {
    newOpen = o;
    if (!o && page.url.pathname.replace(base, "") === "/hosts/new") {
      void goto(`${base}/hosts`, { replaceState: true });
    }
  }}
/>
<QuickVmDialog bind:open={quickOpen} />
<InsecureApprovalsDialog bind:open={insecureOpen} />
<SeedAuthDialog bind:open={seedOpen} />
