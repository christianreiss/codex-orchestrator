<script lang="ts">
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import StatusPill from "./StatusPill.svelte";
  import EngineBadge from "./EngineBadge.svelte";
  import InsecureCountdown from "./InsecureCountdown.svelte";
  import { relativeTime } from "$lib/utils/format";
  import {
    hostEngines,
    hostLatestRefresh,
    hostLatestRefreshMs,
    hostStatusKind,
    hostStatusLabel,
    isInsecureWindowActive,
  } from "$lib/api/hosts";
  import type { HostListItem } from "$lib/api/types";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { cn } from "$lib/utils/cn";

  type SortField =
    | "fqdn"
    | "status"
    | "last_refresh"
    | "client_version"
    | "insecure_enabled_until";
  type SortDir = "asc" | "desc";

  type Props = {
    rows: HostListItem[];
    loading?: boolean;
  };
  let { rows, loading = false }: Props = $props();

  // --- sorting ------------------------------------------------------------
  let sortField = $state<SortField>("fqdn");
  let sortDir = $state<SortDir>("asc");

  function setSort(f: SortField): void {
    if (sortField === f) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortField = f;
      sortDir = "asc";
    }
  }

  const sorted = $derived.by(() => {
    const copy = rows.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortField];
      const bv = (b as unknown as Record<string, unknown>)[sortField];
      if (sortField === "status") {
        return hostStatusLabel(a).localeCompare(hostStatusLabel(b)) * dir;
      }
      if (sortField === "last_refresh") {
        return ((hostLatestRefreshMs(a) ?? 0) - (hostLatestRefreshMs(b) ?? 0)) * dir;
      }
      if (sortField === "client_version") {
        const av2 = a.client_version_override ?? a.client_version;
        const bv2 = b.client_version_override ?? b.client_version;
        if (av2 === bv2) return 0;
        if (av2 === null || av2 === undefined) return 1;
        if (bv2 === null || bv2 === undefined) return -1;
        return String(av2).localeCompare(String(bv2)) * dir;
      }
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      if (typeof av === "boolean" && typeof bv === "boolean") return (Number(av) - Number(bv)) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return copy;
  });

  // --- virtualization -----------------------------------------------------
  let scrollEl: HTMLDivElement | undefined = $state();
  const rowHeight = 56;

  const virtualizer = $derived.by(() => {
    if (!scrollEl) return null;
    return createVirtualizer<HTMLDivElement, HTMLDivElement>({
      count: sorted.length,
      getScrollElement: () => scrollEl ?? null,
      estimateSize: () => rowHeight,
      overscan: 12,
    });
  });

  const virtualItems = $derived($virtualizer?.getVirtualItems() ?? []);
  const totalSize = $derived($virtualizer?.getTotalSize() ?? sorted.length * rowHeight);

  function openHost(h: HostListItem): void {
    void goto(`${base}/hosts/${h.id}`);
  }
</script>

<div class="rounded-lg border bg-card text-card-foreground">
  <div
    class="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_120px_120px_140px_120px] items-center gap-3 border-b bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground"
  >
    {@render headerCell("Host", "fqdn")}
    <div>Engines</div>
    {@render headerCell("Status", "status")}
    {@render headerCell("Last seen", "last_refresh")}
    {@render headerCell("Codex ver.", "client_version")}
    {@render headerCell("Insecure", "insecure_enabled_until")}
  </div>

  <div
    bind:this={scrollEl}
    class="relative h-[60vh] min-h-[400px] overflow-auto"
    role="rowgroup"
  >
    {#if loading}
      <div class="px-4 py-6 text-sm text-muted-foreground">Loading hosts…</div>
    {:else if sorted.length === 0}
      <div class="flex h-full items-center justify-center px-4 py-12 text-sm text-muted-foreground">
        No hosts match the current filter.
      </div>
    {:else}
      <div style="height: {totalSize}px; position: relative; width: 100%;">
        {#each virtualItems as virtual (virtual.key)}
          {@const row = sorted[virtual.index]}
          {#if row}
            {@const engines = hostEngines(row)}
            {@const insecureActive = isInsecureWindowActive(row)}
            <button
              type="button"
              class={cn(
                "absolute left-0 top-0 grid w-full grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_120px_120px_140px_120px] items-center gap-3 border-b px-4 text-left text-sm transition-colors hover:bg-accent/40 focus:bg-accent/60 focus:outline-none",
              )}
              style="transform: translateY({virtual.start}px); height: {rowHeight}px;"
              onclick={() => openHost(row)}
            >
              <div class="min-w-0">
                <div class="truncate font-medium">{row.fqdn}</div>
                <div class="truncate text-[11px] text-muted-foreground">
                  {row.ip4 ?? row.ip6 ?? "—"} · #{row.id}
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-1">
                {#each engines as engine}
                  <EngineBadge
                    {engine}
                    dim={engine === "codex"
                      ? !row.canonical_digest
                      : engine === "claude"
                        ? !row.claude_canonical_digest
                        : false}
                  />
                {/each}
                {#if row.vip}
                  <span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">VIP</span>
                {/if}
                {#if row.allow_roaming_ips}
                  <span class="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-300">Roam</span>
                {/if}
              </div>
              <div>
                {@render statusCell(row, insecureActive)}
              </div>
              <div class="truncate text-xs text-muted-foreground">
                {relativeTime(hostLatestRefresh(row)) || "—"}
              </div>
              <div class="truncate font-mono text-[11px] text-muted-foreground">
                {row.client_version_override ?? row.client_version ?? "—"}
              </div>
              <div>
                <InsecureCountdown until={row.insecure_enabled_until} />
              </div>
            </button>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

{#snippet headerCell(label: string, field: SortField)}
  <button
    type="button"
    class={cn(
      "inline-flex items-center gap-1 text-left transition-colors hover:text-foreground",
      sortField === field ? "text-foreground" : "",
    )}
    onclick={() => setSort(field)}
  >
    {label}
    {#if sortField !== field}
      <ChevronsUpDown class="h-3 w-3 opacity-50" />
    {:else if sortDir === "asc"}
      <ChevronUp class="h-3 w-3" />
    {:else}
      <ChevronDown class="h-3 w-3" />
    {/if}
  </button>
{/snippet}

{#snippet statusCell(host: HostListItem, insecureActive: boolean)}
  {#if insecureActive}
    <StatusPill tone="warning" label="Insecure" />
  {:else if hostStatusKind(host) === "online"}
    <StatusPill tone="online" label="Online" />
  {:else if hostStatusKind(host) === "auth-missing"}
    <StatusPill tone="warning" label="Auth missing" />
  {:else if hostStatusKind(host) === "auth-outdated"}
    <StatusPill tone="warning" label="Outdated auth" />
  {:else if hostStatusKind(host) === "offline"}
    <StatusPill tone="offline" label="Offline" />
  {:else}
    <StatusPill tone="muted" label={hostStatusLabel(host)} />
  {/if}
{/snippet}
