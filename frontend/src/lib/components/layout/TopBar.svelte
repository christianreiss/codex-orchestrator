<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { NAV, isActive } from "$lib/nav";
  import { commandPalette } from "$lib/stores/command-palette";
  import { hostsSummary } from "$lib/stores/hosts-summary";
  import { wsStatus } from "$lib/stores/ws-status";
  import { setTheme } from "$lib/stores/theme";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";

  const activeWindows = $derived($hostsSummary.activeInsecureWindows);

  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const activeNavItem = $derived(NAV.find((item) => isActive(item, path)));

  // Breadcrumb text derived purely from the route: the active NAV item's
  // label, plus any extra path segments beyond it (e.g. an id or slug),
  // humanized minimally (dashes/underscores -> spaces, no title-casing).
  const pageContext = $derived.by(() => {
    const item = activeNavItem;
    if (!item) return "";
    const hrefSegments = item.href.split("/").filter(Boolean);
    const pathSegments = path.split("/").filter(Boolean);
    let shared = 0;
    while (
      shared < hrefSegments.length &&
      shared < pathSegments.length &&
      hrefSegments[shared] === pathSegments[shared]
    ) {
      shared++;
    }
    // Match-based nav items (e.g. /logs, /settings) only guarantee the first
    // path segment matches the section; fall back to that when nothing else
    // was shared with the item's href.
    if (shared === 0 && item.match) shared = 1;
    const remainder = pathSegments.slice(shared).map((seg) => seg.replace(/[-_]/g, " "));
    if (remainder.length === 0) return item.label;
    return `${item.label} / ${remainder.join(" / ")}`;
  });

  const wsIndicator = $derived.by(() => {
    switch ($wsStatus) {
      case "open":
        return { tone: "online" as const, label: "Live", tooltip: "Live updates connected" };
      case "connecting":
      case "idle":
        return {
          tone: "warning" as const,
          label: "Reconnecting…",
          tooltip: "Reconnecting to live updates…",
        };
      case "closed":
        return {
          tone: "offline" as const,
          label: "Disconnected",
          tooltip: "Live updates disconnected — data may be stale until this recovers.",
        };
      default:
        return null;
    }
  });
</script>

<header
  class="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6"
>
  <div class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
    {pageContext}
  </div>

  <div class="flex items-center gap-2">
    <button
      type="button"
      class="hidden h-9 w-72 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:flex"
      onclick={() => commandPalette.open()}
      aria-label="Open command palette"
    >
      <span class="flex-1 text-left">Search…</span>
      <kbd class="rounded border border-border bg-muted px-1.5 text-xs">⌘K</kbd>
    </button>
    <button
      type="button"
      class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input md:hidden"
      onclick={() => commandPalette.open()}
      aria-label="Open command palette"
    >
      <span aria-hidden="true">⌘K</span>
    </button>

    {#if wsIndicator}
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger class="inline-flex h-9 items-center">
            <StatusPill tone={wsIndicator.tone} label={wsIndicator.label} />
          </Tooltip.Trigger>
          <Tooltip.Content>{wsIndicator.tooltip}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/if}

    {#if activeWindows > 0}
      <a
        href={`${base}/hosts?insecure=1`}
        class="inline-flex h-9 items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 text-sm font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
        title="Insecure windows are open"
      >
        <AlertTriangle class="h-4 w-4" />
        <span>{activeWindows}</span>
      </a>
    {/if}

    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input hover:bg-accent"
        aria-label="Theme"
      >
        <Sun class="h-4 w-4 dark:hidden" />
        <Moon class="hidden h-4 w-4 dark:block" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-40">
        <DropdownMenu.Item onclick={() => setTheme("light")}>
          <Sun class="h-4 w-4" /> Light
        </DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => setTheme("dark")}>
          <Moon class="h-4 w-4" /> Dark
        </DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => setTheme("system")}>
          <Monitor class="h-4 w-4" /> System
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</header>
