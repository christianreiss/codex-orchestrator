<script lang="ts">
  import { onMount } from "svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { Button } from "$lib/components/ui/button";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import Inbox from "@lucide/svelte/icons/inbox";
  import Search from "@lucide/svelte/icons/search";
  import Pause from "@lucide/svelte/icons/pause";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import WifiOff from "@lucide/svelte/icons/wifi-off";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { getBreadcrumbs } from "$lib/nav";
  import { pageLabel } from "$lib/stores/page-label";
  import { commandPalette } from "$lib/stores/command-palette";
  import { insecureSummaryQuery } from "$lib/api/insecure";
  import { isInsecureWindowActive } from "$lib/api/hosts";
  import { wsStatus } from "$lib/stores/ws-status";
  import { feedbackApi, feedbackKeys } from "$lib/api/feedback";
  import { authStore } from "$lib/stores/auth";
  import { cn } from "$lib/utils/cn";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import InsecureCountdown from "$lib/components/hosts/InsecureCountdown.svelte";
  import type { AppearanceControl } from "./appearance.svelte";

  let { appearance }: { appearance: AppearanceControl } = $props();

  let modifierKey = $state("Ctrl");
  onMount(() => {
    modifierKey = /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  });

  // Unhandled orchestrator reports: open and nobody has claimed them. Kept
  // current by the `feedback.changed` invalidation; the interval only covers a
  // dropped live connection.
  const canReadFeedback = $derived($authStore.can("feedback.read"));
  const feedbackSummary = createQuery(
    reactiveOptions(() => ({
      queryKey: [...feedbackKeys.summary],
      queryFn: () => feedbackApi.summary(),
      enabled: canReadFeedback,

    })),
  );
  const openReports = $derived(canReadFeedback ? ($feedbackSummary.data?.open ?? 0) : 0);

  // Temporary access comes from the fleet-wide summary (kept current by the
  // `host.updated` and `insecure.*` invalidations), so the badge is right on
  // every route and on a direct load, not only after visiting /hosts. Windows
  // are counted with the Hosts page's own rule.
  const insecureSummary = insecureSummaryQuery();
  const activeWindows = $derived(($insecureSummary.data?.hosts ?? []).filter((host) => isInsecureWindowActive(host)).length);
  // A fleet-wide auto-allow outranks the per-host count: it is a state of the
  // whole fleet.
  const fleetWindowUntil = $derived.by(() => {
    const fleet = $insecureSummary.data?.fleet_window;
    return fleet?.open ? (fleet.until ?? null) : null;
  });
  const path = $derived(page.url.pathname.replace(base, "") || "/");
  // A detail page names its object (a host's FQDN) once it has loaded.
  const breadcrumbs = $derived(getBreadcrumbs(path, $pageLabel?.path === page.url.pathname ? $pageLabel.label : undefined));
  // Connected is the normal state and takes no room; only a connection that
  // may leave the page stale claims a chip ("Live state transport").
  const wsState = $derived.by(() => {
    if ($wsStatus === "open") return null;
    if ($wsStatus === "idle") return { tone: "warning" as const, label: "Connecting", tooltip: "Waiting for live updates" };
    if ($wsStatus === "connecting") return { tone: "warning" as const, label: "Connecting", tooltip: "Connecting to live updates" };
    if ($wsStatus === "closed") return { tone: "danger" as const, label: "Disconnected", tooltip: "Live updates disconnected; displayed information may be stale" };
    return { tone: "warning" as const, label: "Updates paused", tooltip: "Live updates are disabled; reload to refresh displayed information" };
  });
  // A connection that settles within the grace period never shows a chip, so
  // a page load or a quick reconnect does not flash one and shift the others.
  // Disabled live updates are a configured state and show at once. The status
  // region below always reports the actual state.
  const WS_CHIP_GRACE_MS = 1500;
  const wsDegraded = $derived($wsStatus !== "open" && $wsStatus !== "disabled");
  let wsGraceOver = $state(false);
  $effect(() => {
    if (!wsDegraded) {
      wsGraceOver = false;
      return;
    }
    const timer = setTimeout(() => (wsGraceOver = true), WS_CHIP_GRACE_MS);
    return () => clearTimeout(timer);
  });
  const wsIndicator = $derived($wsStatus === "disabled" || wsGraceOver ? wsState : null);

  // Every top-bar control shares one geometry: 36 px high, 16 px glyph, 4 px
  // corners. Status chips differ only by tone (DESIGN.md §4, shell layout).
  const chip = "inline-flex h-9 shrink-0 items-center gap-1.5 rounded border px-2 text-body-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";
  const tones = {
    info: "border-info/30 bg-info-muted text-info-muted-foreground hover:border-info/60",
    warning: "border-warning/30 bg-warning-muted text-warning-muted-foreground hover:border-warning/60",
    danger: "border-destructive/40 bg-destructive-muted text-destructive-muted-foreground hover:border-destructive/70",
  } as const;
</script>

<header class="sticky top-0 z-30 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-card px-4 py-1 md:px-6">
  <nav class={breadcrumbs.length > 1 ? "min-w-0 flex-1 basis-full sm:basis-40" : "min-w-0 flex-1 basis-24 sm:basis-40"} aria-label="Breadcrumb">
    <ol class="min-w-0 break-words text-body leading-relaxed">
      {#each breadcrumbs as crumb, index (crumb.label + index)}
        {#if index > 0}
          <li aria-hidden="true" class="mx-1.5 inline text-muted-foreground">/</li>
        {/if}
        <li class="inline break-words">
          {#if crumb.route}
            <a href={`${base}${crumb.route}`} class="rounded-sm text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{crumb.label}</a>
          {:else}
            <span class="font-semibold text-foreground" aria-current="page" title={crumb.label}>{crumb.label}</span>
          {/if}
        </li>
      {/each}
    </ol>
  </nav>
  <div class="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
    <!-- Announces connection changes; the chip below is the visible cue. -->
    <p class="sr-only" role="status">{wsState?.tooltip ?? "Live updates connected"}</p>
    {#if wsIndicator}
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger class={cn(chip, tones[wsIndicator.tone], "cursor-default")} aria-label={wsIndicator.tooltip}>
            {#if $wsStatus === "closed"}<WifiOff class="h-4 w-4 shrink-0" aria-hidden="true" />
            {:else if $wsStatus === "disabled"}<Pause class="h-4 w-4 shrink-0" aria-hidden="true" />
            {:else}<RefreshCw class="h-4 w-4 shrink-0" aria-hidden="true" />{/if}
            <span class="hidden sm:inline">{wsIndicator.label}</span>
          </Tooltip.Trigger>
          <Tooltip.Content>{wsIndicator.tooltip}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/if}
    {#if fleetWindowUntil}
      <a href={`${base}/hosts?insecure=1`} class={cn(chip, tones.danger)} aria-label="Fleet temporary access open">
        <AlertTriangle class="h-4 w-4 shrink-0" aria-hidden="true" /><span class="hidden sm:inline">Fleet open</span><span class="sm:hidden">Open</span><InsecureCountdown until={fleetWindowUntil} class="hidden border-0 bg-transparent p-0 font-sans tabular-nums text-current sm:inline" />
      </a>
    {:else if activeWindows > 0}
      <a href={`${base}/hosts?insecure=1`} class={cn(chip, tones.warning)} aria-label={`${activeWindows} temporary access ${activeWindows === 1 ? "window" : "windows"} open`}>
        <AlertTriangle class="h-4 w-4 shrink-0" aria-hidden="true" /><span class="tabular-nums">{activeWindows}</span><span class="hidden sm:inline">access {activeWindows === 1 ? "window" : "windows"}</span>
      </a>
    {/if}
    {#if openReports > 0}
      <a
        href={`${base}/reports`}
        class={cn(chip, tones.info)}
        aria-label={`${openReports} unhandled ${openReports === 1 ? "report" : "reports"}`}
        title={`${openReports} open ${openReports === 1 ? "report" : "reports"} nobody has claimed`}
      >
        <Inbox class="h-4 w-4 shrink-0" aria-hidden="true" /><span class="tabular-nums">{openReports}</span><span class="hidden sm:inline">open</span>
      </a>
    {/if}
    <!-- Rightmost and always present, so it never moves when a chip appears. -->
    <button type="button" class="hidden h-9 w-72 shrink-0 items-center gap-2 whitespace-nowrap rounded border border-input bg-background px-3 text-body-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring xl:flex" onclick={() => commandPalette.open()} aria-label="Open command palette"><Search class="h-4 w-4 shrink-0" aria-hidden="true" /><span class="min-w-0 flex-1 truncate text-left">Search fleet &amp; commands</span><kbd class="keyboard-key shrink-0">{modifierKey} K</kbd></button>
    <Button variant="outline" size="icon" class="shrink-0 text-muted-foreground xl:hidden" onclick={() => commandPalette.open()} aria-label="Open command palette"><Search class="h-4 w-4" aria-hidden="true" /></Button>
  </div>
  {#if appearance.failed}
    <p role="alert" class="flex basis-full flex-wrap items-center gap-2 text-caption text-destructive">
      Could not save appearance. Previous appearance restored.
      <button type="button" class="min-h-8 underline pointer-coarse:min-h-11" onclick={() => appearance.retry()}>Retry appearance</button>
    </p>
  {/if}
</header>
