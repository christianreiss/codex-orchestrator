<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Command from "$lib/components/ui/command";
  import ShortcutsModal from "$lib/components/shortcuts/ShortcutsModal.svelte";
  import { commandPalette } from "$lib/stores/command-palette";
  import {
    STATIC_COMMANDS,
    buildDynamicSources,
    getExternalSources,
    groupOrder,
    type CommandGroup,
    type CommandSource,
    type PaletteCommand,
  } from "./commands";

  // Resolve the query client synchronously during component init so its
  // `getContext` lookup succeeds. Built dynamic sources fetch their data
  // lazily and cache it.
  let sources: CommandSource[] = [];
  try {
    const qc = useQueryClient();
    sources = buildDynamicSources(qc);
  } catch {
    sources = [];
  }

  let open = $state(false);
  let query = $state("");
  let dynamicCommands = $state<PaletteCommand[]>([]);
  let dynamicLoading = $state(false);

  // Track the latest in-flight request so out-of-order resolutions don't
  // clobber the rendered list.
  let inflightToken = 0;

  commandPalette.subscribe((s) => {
    open = s.open;
    if (s.open) {
      query = "";
      dynamicCommands = [];
    }
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function refreshDynamic(q: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const token = ++inflightToken;
      const all = [...sources, ...getExternalSources()];
      if (all.length === 0) {
        dynamicCommands = [];
        return;
      }
      dynamicLoading = true;
      // Resolve each source independently and merge into state as they
      // arrive so the palette stays interactive while requests are flying.
      const pending: PaletteCommand[] = [];
      Promise.allSettled(
        all.map(async (src) => {
          const r = await src(q);
          if (token !== inflightToken) return;
          pending.push(...r);
          // Stream partial results into the rendered list.
          dynamicCommands = [...pending];
        }),
      ).finally(() => {
        if (token === inflightToken) dynamicLoading = false;
      });
    }, 150);
  }

  $effect(() => {
    if (!open) {
      if (debounceTimer) clearTimeout(debounceTimer);
      return;
    }
    refreshDynamic(query);
  });

  function handleOpenChange(next: boolean): void {
    if (next) commandPalette.open();
    else commandPalette.close();
  }

  // Dynamic commands are already filtered against `query` by their source
  // (e.g. project/skill descriptions), which can include fields not present
  // in `cmd.keywords`. Track their ids so the rendered `value` can force a
  // match in cmdk's own re-filtering below, instead of silently losing
  // results that matched on a field cmdk doesn't know about.
  const dynamicIds = $derived(new Set(dynamicCommands.map((c) => c.id)));

  // Merge static + dynamic commands, group, and order.
  const grouped = $derived.by(() => {
    const all = [...STATIC_COMMANDS, ...dynamicCommands];
    const map = new Map<CommandGroup, PaletteCommand[]>();
    for (const cmd of all) {
      const list = map.get(cmd.group) ?? [];
      list.push(cmd);
      map.set(cmd.group, list);
    }
    return [...map.entries()].sort(([a], [b]) => groupOrder(a) - groupOrder(b));
  });

  function onInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="overflow-hidden p-0 sm:max-w-[600px]">
    <Dialog.Title class="sr-only">Command palette</Dialog.Title>
    <Dialog.Description class="sr-only">Search commands and jump anywhere.</Dialog.Description>
    <Command.Root shouldFilter={true} class="[&_[data-cmdk-input-wrapper]]:px-3">
      <Command.Input
        autofocus
        value={query}
        oninput={onInput}
        placeholder="Type a command or search hosts, projects, skills, users…"
      />
      <Command.List class="max-h-[420px]">
        <Command.Empty>No matches.</Command.Empty>
        {#each grouped as [group, items] (group)}
          {#if items.length > 0}
            <Command.Group heading={group}>
              {#each items as cmd (cmd.id)}
                <Command.Item
                  value={`${cmd.label} ${(cmd.keywords ?? []).join(" ")}${
                    dynamicIds.has(cmd.id) ? ` ${query}` : ""
                  }`}
                  onSelect={() => void cmd.run()}
                >
                  {#if cmd.icon}
                    {@const Icon = cmd.icon}
                    <Icon class="h-4 w-4 text-muted-foreground" />
                  {/if}
                  <span class="flex-1 truncate">{cmd.label}</span>
                  {#if cmd.hint}
                    <kbd
                      class="ml-auto rounded border border-border bg-muted px-1.5 text-[10px] font-mono leading-5 text-muted-foreground"
                    >
                      {cmd.hint}
                    </kbd>
                  {/if}
                </Command.Item>
              {/each}
            </Command.Group>
          {/if}
        {/each}
        {#if dynamicLoading}
          <div class="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
        {/if}
      </Command.List>
    </Command.Root>
  </Dialog.Content>
</Dialog.Root>

<!-- Globally mounted shortcuts modal. Opens via the `codex:open-shortcuts`
     window event, dispatched by single-key `?` and by the TopBar kbd hint. -->
<ShortcutsModal />
