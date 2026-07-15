<script lang="ts">
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
  import { getPageContext } from "$lib/nav";
  import { commandPalette } from "$lib/stores/command-palette";
  import { hostsSummary } from "$lib/stores/hosts-summary";
  import { wsStatus } from "$lib/stores/ws-status";
  import { setTheme } from "$lib/stores/theme";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";

  const activeWindows = $derived($hostsSummary.activeInsecureWindows);
  const path = $derived(page.url.pathname.replace(base, "") || "/");
  const pageContext = $derived(getPageContext(path));

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
  class="sticky top-0 z-30 flex h-[4.25rem] shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/72 sm:px-6"
>
  <div class="flex min-w-0 items-center gap-2 text-sm" aria-label="Current location">
    <span class="hidden font-medium text-muted-foreground lg:inline">Workspace</span>
    <span class="hidden text-border lg:inline">/</span>
    <span class="truncate font-medium text-foreground">{pageContext}</span>
  </div>

  <div class="flex shrink-0 items-center gap-2">
    <button
      type="button"
      class="group hidden h-10 w-72 items-center gap-2.5 rounded-xl border border-input/80 bg-card/70 px-3 text-sm text-muted-foreground shadow-sm transition-all hover:border-foreground/15 hover:bg-card hover:text-foreground hover:shadow-md lg:flex xl:w-80"
      onclick={() => commandPalette.open()}
      aria-label="Open command palette"
    >
      <Search class="h-4 w-4 transition-colors group-hover:text-foreground" />
      <span class="flex-1 text-left">Search or run a command</span>
      <kbd class="rounded-md border border-border bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">⌘ K</kbd>
    </button>
    <button
      type="button"
      class="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-input/80 bg-card/70 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground lg:hidden"
      onclick={() => commandPalette.open()}
      aria-label="Open command palette"
    >
      <Search class="h-[18px] w-[18px]" />
    </button>

    {#if wsIndicator}
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger class="hidden h-10 items-center sm:inline-flex">
            <StatusPill tone={wsIndicator.tone} label={wsIndicator.label} />
          </Tooltip.Trigger>
          <Tooltip.Content>{wsIndicator.tooltip}</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    {/if}

    {#if activeWindows > 0}
      <a
        href={`${base}/hosts?insecure=1`}
        class="inline-flex h-10 items-center gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-2.5 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300 sm:px-3"
        title="Insecure windows are open"
        aria-label={`${activeWindows} insecure windows open`}
      >
        <AlertTriangle class="h-4 w-4" />
        <span>{activeWindows}</span>
      </a>
    {/if}

    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-input/80 bg-card/70 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Appearance"
      >
        <Sun class="h-[18px] w-[18px] dark:hidden" />
        <Moon class="hidden h-[18px] w-[18px] dark:block" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-48">
        <DropdownMenu.Label>Appearance</DropdownMenu.Label>
        <DropdownMenu.Item onclick={() => setTheme("light")}>
          <Sun class="h-4 w-4" /> Light
        </DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => setTheme("dark")}>
          <Moon class="h-4 w-4" /> Dark
        </DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => setTheme("system")}>
          <Monitor class="h-4 w-4" /> System
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onclick={() => goto(`${base}/account/theme`)}>
          <Palette class="h-4 w-4" /> Theme settings
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</header>
