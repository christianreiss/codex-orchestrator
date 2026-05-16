<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import * as Dialog from "$lib/components/ui/dialog";

  /**
   * Lists every keyboard shortcut in the new WebUI. Multi-key chord
   * shortcuts have been intentionally removed — these are the only
   * keybindings to know.
   */
  interface ShortcutEntry {
    keys: string[];
    description: string;
  }

  // Best-effort platform detection for the Cmd / Ctrl glyph.
  const isMac =
    browser && typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  const ENTRIES: ShortcutEntry[] = [
    { keys: [modKey, "K"], description: "Open the command palette" },
    { keys: ["/"], description: "Focus the command palette search" },
    { keys: ["?"], description: "Show this shortcuts list" },
    { keys: ["Esc"], description: "Close any open overlay" },
  ];

  let open = $state(false);

  function handleOpen(): void {
    open = true;
  }

  let listener: ((e: Event) => void) | null = null;

  onMount(() => {
    if (!browser) return;
    listener = () => handleOpen();
    window.addEventListener("codex:open-shortcuts", listener);
  });

  onDestroy(() => {
    if (browser && listener) {
      window.removeEventListener("codex:open-shortcuts", listener);
    }
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Keyboard shortcuts</Dialog.Title>
      <Dialog.Description>
        Every shortcut available in the WebUI.
      </Dialog.Description>
    </Dialog.Header>

    <div class="mt-2 grid grid-cols-1 gap-2">
      {#each ENTRIES as entry (entry.description)}
        <div
          class="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/40 px-3 py-2"
        >
          <span class="text-sm text-foreground">{entry.description}</span>
          <span class="flex items-center gap-1">
            {#each entry.keys as key, i (i)}
              {#if i > 0}
                <span class="text-xs text-muted-foreground">+</span>
              {/if}
              <kbd
                class="inline-flex min-w-[1.75rem] items-center justify-center rounded border border-border bg-background px-1.5 py-0.5 text-xs font-mono font-medium text-foreground shadow-sm"
              >
                {key}
              </kbd>
            {/each}
          </span>
        </div>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
