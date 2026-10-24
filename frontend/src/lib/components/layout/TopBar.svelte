<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import Inbox from "@lucide/svelte/icons/inbox";
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
  import { setTheme, themeStore, type ThemeChoice } from "$lib/stores/theme";
  import { accountKeys, setTheme as persistTheme } from "$lib/api/account";
  import { feedbackApi, feedbackKeys } from "$lib/api/feedback";
  import { authStore } from "$lib/stores/auth";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";
  import InsecureCountdown from "$lib/components/hosts/InsecureCountdown.svelte";

  const qc = useQueryClient();
  const themeMutation = createMutation({
    mutationFn: (value: ThemeChoice) => persistTheme(value === "system" ? "auto" : value),
    onMutate: async (value: ThemeChoice) => {
      const previous = get(themeStore);
      await qc.cancelQueries({ queryKey: accountKeys.theme });
      setTheme(value);
      qc.setQueryData(accountKeys.theme, { theme: value === "system" ? "auto" : value });
      return { previous };
    },
    onSuccess: (data) => qc.setQueryData(accountKeys.theme, data),
    onError: (error, _value, context) => {
      if (context) {
        setTheme(context.previous);
        qc.setQueryData(accountKeys.theme, { theme: context.previous === "system" ? "auto" : context.previous });
      }
      toast.error("Could not save appearance", { description: error.message });
    },
  });

  let appearanceContent = $state<HTMLDivElement | null>(null);
  function focusAppearanceMenu(event: Event) {
    event.preventDefault();
    const content = appearanceContent;
    // Bits UI can remount its focus scope while opening, queuing autofocus
    // twice. A later callback must preserve an item reached with ArrowDown.
    requestAnimationFrame(() => {
      if (!content?.isConnected || content !== appearanceContent || content.dataset.state !== "open") return;
      if (!content.contains(document.activeElement)) content.focus({ preventScroll: true });
    });
  }

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
  const openReports = $derived($feedbackSummary.data?.open ?? 0);

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
    if ($wsStatus === "closed") return { tone: "offline" as const, label: "Disconnected", tooltip: "Live updates disconnected; displayed information may be stale" };
    return { tone: "warning" as const, label: "Updates paused", tooltip: "Live updates are disabled; reload to refresh displayed information" };
  });
</script>

<header class="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-card px-4 sm:gap-4 md:px-6">
  <nav class="min-w-0 overflow-hidden" aria-label="Breadcrumb">
    <ol class="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-body">
      {#each breadcrumbs as crumb, index (crumb.label + index)}
        {#if index > 0}
          <li aria-hidden="true" class="shrink-0 text-muted-foreground/55">/</li>
        {/if}
        <li class={crumb.route ? "min-w-0 shrink truncate" : "min-w-0 truncate"}>
          {#if crumb.route}
            <a href={`${base}${crumb.route}`} class="inline-flex min-h-6 min-w-6 items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{crumb.label}</a>
          {:else}
            <span class="font-semibold text-foreground" aria-current="page" title={crumb.label}>{crumb.label}</span>
          {/if}
        </li>
      {/each}
    </ol>
  </nav>
  <div class="flex shrink-0 items-center gap-1 sm:gap-2">
    <button type="button" class="hidden h-9 w-72 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border bg-background px-3 text-body-sm text-muted-foreground outline-none transition-colors hover:border-input hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring xl:flex" onclick={() => commandPalette.open()} aria-label="Open command palette"><Search class="h-4 w-4 shrink-0" /><span class="min-w-0 flex-1 truncate text-left">Search fleet &amp; commands</span><kbd class="keyboard-key shrink-0">{modifierKey} K</kbd></button>
    <button type="button" class="shell-icon-button xl:hidden" onclick={() => commandPalette.open()} aria-label="Open command palette"><Search class="h-4 w-4" /></button>
    {#if wsIndicator}
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger class={["h-9 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", wsIndicator.tone === "online" ? "hidden sm:inline-flex" : "inline-flex min-w-9 justify-center"]} aria-label={wsIndicator.tooltip}>
            <span class={["h-2.5 w-2.5 rounded-full sm:hidden", wsIndicator.tone === "offline" ? "bg-destructive" : "bg-warning"]} aria-hidden="true"></span>
            <StatusPill class="hidden sm:inline-flex" tone={wsIndicator.tone} label={wsIndicator.label} />
          </Tooltip.Trigger>
          <Tooltip.Content>{wsIndicator.tooltip}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/if}
    {#if openReports > 0}
      <a
        href={`${base}/reports`}
        class="inline-flex h-9 items-center gap-1.5 rounded-md border border-info/30 bg-info-muted px-2 text-body-sm font-medium text-info-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${openReports} unhandled ${openReports === 1 ? "report" : "reports"}`}
        title={`${openReports} open ${openReports === 1 ? "report" : "reports"} nobody has claimed`}
      >
        <Inbox class="h-4 w-4 shrink-0" /><span class="tabular-nums">{openReports}</span><span class="hidden sm:inline">open</span>
      </a>
    {/if}
    {#if fleetWindowUntil}
      <a href={`${base}/hosts?insecure=1`} class="inline-flex h-9 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive-muted px-2 text-body-sm font-medium text-destructive-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Fleet temporary access open">
        <AlertTriangle class="h-4 w-4 shrink-0" /><span class="hidden sm:inline">Fleet open</span><span class="sm:hidden">Open</span><InsecureCountdown until={fleetWindowUntil} class="hidden sm:inline" />
      </a>
    {:else if activeWindows > 0}
      <a href={`${base}/hosts?insecure=1`} class="inline-flex h-9 items-center gap-1.5 rounded-md border border-warning/30 bg-warning-muted px-2 text-body-sm font-medium text-warning-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${activeWindows} temporary access windows open`}><AlertTriangle class="h-4 w-4" />{activeWindows}</a>
    {/if}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class="shell-icon-button" aria-label="Appearance"><Sun class="h-4 w-4 dark:hidden" /><Moon class="hidden h-4 w-4 dark:block" /></DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-44" bind:ref={appearanceContent} onOpenAutoFocus={focusAppearanceMenu}>
        <DropdownMenu.Group>
          <DropdownMenu.Label>Appearance</DropdownMenu.Label>
          <DropdownMenu.Item disabled={$themeMutation.isPending} onSelect={() => $themeMutation.mutate("light")}><Sun class="h-4 w-4" />Light</DropdownMenu.Item>
          <DropdownMenu.Item disabled={$themeMutation.isPending} onSelect={() => $themeMutation.mutate("dark")}><Moon class="h-4 w-4" />Dark</DropdownMenu.Item>
          <DropdownMenu.Item disabled={$themeMutation.isPending} onSelect={() => $themeMutation.mutate("system")}><Monitor class="h-4 w-4" />System</DropdownMenu.Item>
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={() => goto(`${base}/account#appearance`)}><Palette class="h-4 w-4" />Appearance settings</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</header>
