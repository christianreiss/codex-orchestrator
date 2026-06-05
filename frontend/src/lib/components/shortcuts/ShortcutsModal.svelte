<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { browser } from "$app/environment";
  import * as Dialog from "$lib/components/ui/dialog";

  interface ShortcutEntry {
    keys: string[];
    description: string;
  }

  interface ShortcutGroup {
    title: string;
    entries: ShortcutEntry[];
  }

  // Best-effort platform detection for the Cmd / Ctrl glyph.
  const isMac =
    browser && typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  const GROUPS: ShortcutGroup[] = [
    {
      title: "Navigation",
      entries: [
        { keys: [modKey, "K"], description: "Command palette öffnen" },
        { keys: ["/"], description: "Command palette fokussieren" },
        { keys: ["Esc"], description: "Overlay schließen" },
      ],
    },
    {
      title: "Aktionen",
      entries: [
        { keys: ["N"], description: "Neuen Host anlegen" },
      ],
    },
    {
      title: "Hilfe",
      entries: [
        { keys: ["?"], description: "Diese Übersicht anzeigen" },
      ],
    },
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
      <Dialog.Title>Tastenkürzel</Dialog.Title>
      <Dialog.Description>
        Alle verfügbaren Shortcuts im WebUI.
      </Dialog.Description>
    </Dialog.Header>

    <div class="mt-2 space-y-4">
      {#each GROUPS as group (group.title)}
        <div>
          <p class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.title}
          </p>
          <div class="grid grid-cols-1 gap-1.5">
            {#each group.entries as entry (entry.description)}
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
        </div>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
