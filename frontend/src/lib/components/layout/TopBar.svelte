<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Monitor from "@lucide/svelte/icons/monitor";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import { commandPalette } from "$lib/stores/command-palette";
  import { setTheme } from "$lib/stores/theme";

  let { activeWindows = 0 }: { activeWindows?: number } = $props();
</script>

<header
  class="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:px-6"
>
  <div class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
    <!-- Page title context — feature pages render their own PageHeader inside main. -->
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

    {#if activeWindows > 0}
      <a
        href="/admin/hosts?filter=insecure"
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
