<script lang="ts">
  import { onDestroy } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Command from "$lib/components/ui/command";
  import ShortcutsModal from "$lib/components/shortcuts/ShortcutsModal.svelte";
  import { commandPalette } from "$lib/stores/command-palette";
  import { getRecentCommandIds, recordRecentCommand } from "$lib/stores/recent-commands";
  import {
    STATIC_COMMANDS,
    buildDynamicSources,
    buildRecentCommands,
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
  let dynamicError = $state(false);
  let recentIds = $state<string[]>([]);

  // Track the latest in-flight request so out-of-order resolutions don't
  // clobber the rendered list.
  let inflightToken = 0;

  const unsubscribe = commandPalette.subscribe((s) => {
    open = s.open;
    if (s.open) {
      query = "";
      dynamicCommands = [];
      recentIds = getRecentCommandIds();
    }
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function refreshDynamic(q: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    // Invalidate immediately, including the debounce interval. A slow result
    // for the previous query must never become selectable under the new one.
    const token = ++inflightToken;
    dynamicCommands = [];
    dynamicError = false;
    dynamicLoading = sources.length > 0;
    if (sources.length === 0) return;
    debounceTimer = setTimeout(() => {
      // Resolve each source independently and merge into state as they
      // arrive so the palette stays interactive while requests are flying.
      const pending: PaletteCommand[] = [];
      Promise.allSettled(
        sources.map(async (src) => {
          const r = await src(q);
          if (token !== inflightToken) return;
          pending.push(...r);
          // Stream partial results into the rendered list.
          dynamicCommands = [...pending];
        }),
      ).then((results) => {
        if (token !== inflightToken) return;
        dynamicLoading = false;
        dynamicError = results.some((result) => result.status === "rejected");
      });
    }, 150);
  }

  $effect(() => {
    if (!open) {
      if (debounceTimer) clearTimeout(debounceTimer);
      inflightToken++;
      dynamicLoading = false;
      return;
    }
    refreshDynamic(query);
  });

  onDestroy(() => {
    unsubscribe();
    if (debounceTimer) clearTimeout(debounceTimer);
    inflightToken++;
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

  // Static (and by extension "Recent", which only ever wraps static
  // entries) command ids, used to decide what's eligible to be recorded
  // into recent-command history below.
  const staticIds = new Set(STATIC_COMMANDS.map((c) => c.id));

  // Merge static + dynamic commands, group, and order. "Recent" only makes
  // sense as a jump-back-in aid on the empty-query default view — it's
  // dropped once the user is actively searching.
  const grouped = $derived.by(() => {
    const recent = query === "" && recentIds.length > 0 ? buildRecentCommands(recentIds) : [];
    const all = [...recent, ...STATIC_COMMANDS, ...dynamicCommands];
    const map = new Map<CommandGroup, PaletteCommand[]>();
    for (const cmd of all) {
      const list = map.get(cmd.group) ?? [];
      list.push(cmd);
      map.set(cmd.group, list);
    }
    return [...map.entries()].sort(([a], [b]) => groupOrder(a) - groupOrder(b));
  });

  function selectCommand(cmd: PaletteCommand): void {
    const originalId = cmd.id.startsWith("recent:") ? cmd.id.slice("recent:".length) : cmd.id;
    if (staticIds.has(originalId)) recordRecentCommand(originalId);
    void cmd.run();
  }

  function onInput(event: Event): void {
    query = (event.currentTarget as HTMLInputElement).value;
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="top-[max(1rem,12dvh)] max-h-[calc(100dvh-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[640px] sm:p-0">
    <Dialog.Title class="sr-only">Command palette</Dialog.Title>
    <Dialog.Description class="sr-only">Search fleet destinations, hosts, projects, skills, and users. Use arrow keys to choose a result and Enter to open it.</Dialog.Description>
    <Command.Root shouldFilter={true} class="[&_[data-cmdk-input-wrapper]]:pl-4 [&_[data-cmdk-input-wrapper]]:pr-14">
      <Command.Input
        autofocus
        value={query}
        oninput={onInput}
        placeholder="Search fleet or run a command…"
        aria-label="Search fleet and commands"
        class="h-16"
      />
      <Command.List class="max-h-[min(420px,55dvh)] overscroll-contain">
        <Command.Empty>
          {#if dynamicLoading}
            <span class="text-muted-foreground">Searching the fleet…</span>
          {:else}
            <span class="block font-medium">No results found</span>
            <span class="mt-1 block text-xs text-muted-foreground">Try a host name, project, skill, or destination.</span>
          {/if}
        </Command.Empty>
        {#each grouped as [group, items] (group)}
          {#if items.length > 0}
            <Command.Group heading={group}>
              {#each items as cmd (cmd.id)}
                <Command.Item
                  value={`${cmd.id} ${cmd.label} ${cmd.description ?? ""} ${(cmd.keywords ?? []).join(" ")}${
                    dynamicIds.has(cmd.id) ? ` ${query}` : ""
                  }`}
                  onSelect={() => selectCommand(cmd)}
                  class="group min-h-12 rounded-md px-3"
                >
                  {#if cmd.icon}
                    {@const Icon = cmd.icon}
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-background"><Icon class="h-4 w-4 text-muted-foreground" /></span>
                  {/if}
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-medium">{cmd.label}</span>
                    {#if cmd.description}<span class="mt-0.5 block truncate text-xs text-muted-foreground">{cmd.description}</span>{/if}
                  </span>
                  {#if cmd.hint}
                    <kbd
                      class="ml-auto rounded border border-border bg-muted px-1.5 text-[10px] font-mono leading-5 text-muted-foreground"
                    >
                      {cmd.hint}
                    </kbd>
                  {/if}
                  {#if cmd.group === "Navigation" || dynamicIds.has(cmd.id)}<ArrowUpRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{/if}
                </Command.Item>
              {/each}
            </Command.Group>
          {/if}
        {/each}
      </Command.List>
    </Command.Root>
    <div class="flex min-h-10 items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
      <span role="status" class="flex min-w-0 items-center gap-2">
        {#if dynamicLoading}<LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin" />Searching fleet…
        {:else if dynamicError}Some fleet results are unavailable.
        {:else}Navigate your workspace{/if}
      </span>
      <span class="hidden shrink-0 items-center gap-3 sm:flex" aria-hidden="true"><span><kbd class="keyboard-key">↑ ↓</kbd> select</span><span><kbd class="keyboard-key">↵</kbd> open</span><span><kbd class="keyboard-key">Esc</kbd> close</span></span>
    </div>
  </Dialog.Content>
</Dialog.Root>

<!-- Globally mounted shortcuts modal. Opens via the `codex:open-shortcuts`
     window event, dispatched by single-key `?` and navigation help controls. -->
<ShortcutsModal />
