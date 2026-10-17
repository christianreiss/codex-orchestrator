<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { PageShell, StatStrip, Toolbar, type Stat } from "$lib/components/page";
  import { hostsListQuery, isInsecureWindowActive } from "$lib/api/hosts";
  import { insecureApprovalsQuery } from "$lib/api/insecure";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { hostsSummary } from "$lib/stores/hosts-summary";
  import { HostsListState } from "$lib/components/hosts/hostsListState.svelte";
  import HostsTable from "$lib/components/hosts/HostsTable.svelte";
  import HostsFilters from "$lib/components/hosts/HostsFilters.svelte";
  import HostsActions from "$lib/components/hosts/HostsActions.svelte";
  import NewHostSheet from "$lib/components/hosts/NewHostSheet.svelte";
  import QuickVmDialog from "$lib/components/hosts/QuickVmDialog.svelte";
  import SeedAuthDialog from "$lib/components/hosts/SeedAuthDialog.svelte";

  const hosts = hostsListQuery();
  const approvals = insecureApprovalsQuery();
  const fleet = useFleetEngines();

  // A request is actionable while it is pending, unexpired and its host is still polling.
  const waiting = $derived(
    new Set(
      ($approvals.data?.requests ?? [])
        .filter((r) => r.status === "pending" && r.live !== false && (!r.expires_at || Date.parse(r.expires_at) > Date.now()))
        .map((r) => r.host_id),
    ),
  );
  const list = new HostsListState(
    () => $hosts.data?.hosts ?? [],
    () => waiting,
    () => $fleet.disabled,
  );

  const stats = $derived.by<Stat[]>(() => {
    const { total, online, attention } = list.counts;
    return [
      { label: total === 1 ? "host" : "hosts", value: total },
      { label: "online", value: online, tone: "success" },
      { label: "need attention", value: attention, tone: attention > 0 ? "warning" : "default" },
    ];
  });

  // The top bar reads the number of open temporary-access windows from here.
  $effect(() => {
    hostsSummary.setActiveInsecureWindows(list.all.filter((r) => isInsecureWindowActive(r.host)).length);
  });

  // --- sheets and dialogs -------------------------------------------------
  let addOpen = $state(false);
  let quickOpen = $state(false);
  let seedOpen = $state(false);

  function reviewAccess(): void {
    window.dispatchEvent(new CustomEvent("codex:open-insecure-approvals"));
  }

  function dropParams(...keys: string[]): void {
    const url = new URL(page.url);
    if (!keys.some((key) => url.searchParams.has(key))) return;
    keys.forEach((key) => url.searchParams.delete(key));
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  // Deep links: ?add=1 (and the older ?dialog=new-host), ?dialog=quick-vm, ?insecure=1.
  $effect(() => {
    const params = page.url.searchParams;
    if (params.get("add") === "1" || params.get("dialog") === "new-host") addOpen = true;
    if (params.get("dialog") === "quick-vm") quickOpen = true;
    if (params.get("insecure") === "1") {
      reviewAccess();
      dropParams("insecure");
    }
  });

  onMount(() => {
    const openAdd = () => (addOpen = true);
    const openQuick = () => (quickOpen = true);
    window.addEventListener("codex:open-new-host", openAdd);
    window.addEventListener("codex:open-quick-vm", openQuick);
    return () => {
      window.removeEventListener("codex:open-new-host", openAdd);
      window.removeEventListener("codex:open-quick-vm", openQuick);
    };
  });
</script>

<PageShell title="Hosts" description="Every machine, and what needs doing on it." width="wide">
  {#snippet actions()}
    <HostsActions onAdd={() => (addOpen = true)} onQuickVm={() => (quickOpen = true)} onSeedAuth={() => (seedOpen = true)} onReviewAccess={reviewAccess} />
  {/snippet}
  {#snippet subheader()}
    {#if !$hosts.isLoading && !$hosts.isError}<StatStrip items={stats} />{/if}
  {/snippet}

  <Toolbar bind:search={list.search} searchPlaceholder="Search hosts" count={list.filtered ? `${list.rows.length} of ${list.counts.total}` : undefined}>
    {#snippet filters()}<HostsFilters state={list} />{/snippet}
  </Toolbar>

  <HostsTable
    state={list}
    loading={$hosts.isLoading}
    error={$hosts.isError ? `Could not load hosts: ${$hosts.error?.message ?? "unknown error"}` : null}
    onRetry={() => void $hosts.refetch()}
    onAdd={() => (addOpen = true)}
    onReviewAccess={reviewAccess}
  />
</PageShell>

<NewHostSheet bind:open={addOpen} onOpenChange={(o) => { addOpen = o; if (!o) dropParams("add", "dialog"); }} />
<QuickVmDialog bind:open={quickOpen} onOpenChange={(o) => { quickOpen = o; if (!o) dropParams("dialog"); }} />
<SeedAuthDialog bind:open={seedOpen} />
