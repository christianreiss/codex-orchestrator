<script lang="ts">
  import { onMount } from "svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";
  import Palette from "@lucide/svelte/icons/palette";
  import Search from "@lucide/svelte/icons/search";
  import Sun from "@lucide/svelte/icons/sun";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { goto } from "$app/navigation";
  import { getBreadcrumbs } from "$lib/nav";
  import { commandPalette } from "$lib/stores/command-palette";
  import { hostsSummary } from "$lib/stores/hosts-summary";
  import { wsStatus } from "$lib/stores/ws-status";
  import { setTheme } from "$lib/stores/theme";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";
  import InsecureCountdown from "$lib/components/hosts/InsecureCountdown.svelte";

  let modifierKey = $state("Ctrl");
  onMount(() => {
    modifierKey = /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  });

  const activeWindows = $derived($hostsSummary.activeInsecureWindows);
  // A fleet-wide auto-allow outranks the per-host count: it is a state of the
  // whole fleet, and it is live on every route rather than only on /hosts.
  const fleetWindowUntil = $derived($hostsSummary.fleetWindowUntil);
  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const breadcrumbs = $derived(getBreadcrumbs(path));
  const wsIndicator = $derived.by(() => {
    if ($wsStatus === "open") return { tone: "online" as const, label: "Live", tooltip: "Live updates connected" };
    if ($wsStatus === "idle") return { tone: "warning" as const, label: "Connecting", tooltip: "Waiting for live updates" };
    if ($wsStatus === "connecting") return { tone: "warning" as const, label: "Connecting", tooltip: "Connecting to live updates" };
    if ($wsStatus === "closed") return { tone: "offline" as const, label: "Disconnected", tooltip: "Live updates disconnected" };
    return null;
  });
</script>

<header class="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-2 border-b bg-card px-4 sm:gap-4 sm:px-6 md:px-8">
  <nav class="min-w-0 overflow-hidden" aria-label="Breadcrumb">
    <ol class="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-sm">
      {#each breadcrumbs as crumb, index (crumb.label + index)}
        {#if index > 0}
          <li aria-hidden="true" class="shrink-0 text-muted-foreground/55">/</li>
        {/if}
        <li class={crumb.route ? "min-w-0 shrink truncate" : "min-w-0 truncate"}>
          {#if crumb.route}
            <a href={`${base}${crumb.route}`} class="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{crumb.label}</a>
          {:else}
            <span class="font-semibold text-foreground" aria-current="page" title={crumb.label}>{crumb.label}</span>
          {/if}
        </li>
      {/each}
    </ol>
  </nav>
  <div class="flex shrink-0 items-center gap-1 sm:gap-2">
    <button type="button" class="hidden h-9 w-64 items-center gap-2 rounded-md border bg-background px-3 text-xs text-muted-foreground outline-none transition-colors hover:border-input hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring xl:flex" onclick={() => commandPalette.open()} aria-label="Open command palette"><Search class="h-3.5 w-3.5" /><span class="flex-1 text-left">Search fleet &amp; commands</span><kbd class="keyboard-key">{modifierKey} K</kbd></button>
    <button type="button" class="shell-icon-button xl:hidden" onclick={() => commandPalette.open()} aria-label="Open command palette"><Search class="h-4 w-4" /></button>
    {#if wsIndicator}
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger class="hidden h-9 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex" aria-label={wsIndicator.tooltip}>
            <StatusPill tone={wsIndicator.tone} label={wsIndicator.label} />
          </Tooltip.Trigger>
          <Tooltip.Content>{wsIndicator.tooltip}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/if}
    {#if fleetWindowUntil}
      <a href={`${base}/hosts?insecure=1`} class="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive-muted px-2 text-xs font-medium text-destructive-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9" aria-label="Fleet insecure window open">
        <AlertTriangle class="h-3.5 w-3.5 shrink-0" /><span class="hidden sm:inline">Fleet open</span><span class="sm:hidden">Open</span><InsecureCountdown until={fleetWindowUntil} class="hidden sm:inline" />
      </a>
    {:else if activeWindows > 0}
      <a href={`${base}/hosts?insecure=1`} class="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-warning/30 bg-warning-muted px-2 text-xs font-medium text-warning-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9" aria-label={`${activeWindows} insecure windows open`}><AlertTriangle class="h-3.5 w-3.5" />{activeWindows}</a>
    {/if}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class="shell-icon-button" aria-label="Appearance"><Sun class="h-4 w-4 dark:hidden" /><Moon class="hidden h-4 w-4 dark:block" /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-44"><DropdownMenu.Label>Appearance</DropdownMenu.Label><DropdownMenu.Item onclick={() => setTheme("light")}><Sun class="h-4 w-4" />Light</DropdownMenu.Item><DropdownMenu.Item onclick={() => setTheme("dark")}><Moon class="h-4 w-4" />Dark</DropdownMenu.Item><DropdownMenu.Item onclick={() => setTheme("system")}><Monitor class="h-4 w-4" />System</DropdownMenu.Item><DropdownMenu.Separator /><DropdownMenu.Item onclick={() => goto(`${base}/account/theme`)}><Palette class="h-4 w-4" />Appearance settings</DropdownMenu.Item></DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</header>
