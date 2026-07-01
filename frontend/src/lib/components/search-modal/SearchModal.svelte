<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Command from "$lib/components/ui/command";
  import { searchModal } from "$lib/stores/search-modal";
  import {
    buildDynamicSources,
    groupOrder,
    type CommandGroup,
    type CommandSource,
    type PaletteCommand,
  } from "$lib/components/command-palette/commands";

  let sources: CommandSource[] = [];
  try {
    const qc = useQueryClient();
    sources = buildDynamicSources(qc);
  } catch {
    sources = [];
  }

  let open = $state(false);
  let query = $state("");
  let results = $state<PaletteCommand[]>([]);
  let loading = $state(false);
  let openKey = $state(0);

  let inflightToken = 0;

  searchModal.subscribe((s) => {
    open = s.open;
    if (s.open) {
      query = "";
      results = [];
      openKey++;
    }
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function refreshResults(q: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const token = ++inflightToken;
      if (sources.length === 0) {
        results = [];
        return;
      }
      loading = true;
      const pending: PaletteCommand[] = [];
      Promise.allSettled(
        sources.map(async (src) => {
          const r = await src(q);
          if (token !== inflightToken) return;
          pending.push(...r);
          results = [...pending];
        }),
      ).finally(() => {
        if (token === inflightToken) loading = false;
      });
    }, 150);
  }

  $effect(() => {
    if (!open) {
      if (debounceTimer) clearTimeout(debounceTimer);
      ++inflightToken;
      results = [];
      return;
    }
    refreshResults(query);
  });

  function handleOpenChange(next: boolean): void {
    if (next) searchModal.open();
    else searchModal.close();
  }

  const grouped = $derived.by(() => {
    const map = new Map<CommandGroup, PaletteCommand[]>();
    for (const cmd of results) {
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
  <Dialog.Content class="overflow-hidden p-0 sm:max-w-[560px]">
    <Dialog.Title class="sr-only">Search</Dialog.Title>
    <Dialog.Description class="sr-only">Search hosts, projects, skills, and users.</Dialog.Description>
    {#key openKey}
    <Command.Root shouldFilter={false} class="[&_[data-cmdk-input-wrapper]]:px-3">
      <Command.Input
        autofocus
        oninput={onInput}
        placeholder="Search hosts, projects, skills, users…"
      />
      <Command.List class="max-h-[420px]">
        {#if query && !loading && results.length === 0}
          <Command.Empty>No results for "{query}"</Command.Empty>
        {/if}
        {#if !query}
          <div class="px-3 py-8 text-center text-sm text-muted-foreground">Type to search…</div>
        {/if}
        {#each grouped as [group, items] (group)}
          {#if items.length > 0}
            <Command.Group heading={group}>
              {#each items as cmd (cmd.id)}
                <Command.Item
                  value={cmd.id}
                  onSelect={() => {
                    searchModal.close();
                    void cmd.run();
                  }}
                >
                  {#if cmd.icon}
                    {@const Icon = cmd.icon}
                    <Icon class="h-4 w-4 text-muted-foreground" />
                  {/if}
                  <span class="flex-1 truncate">{cmd.label}</span>
                </Command.Item>
              {/each}
            </Command.Group>
          {/if}
        {/each}
        {#if loading}
          <div class="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
        {/if}
      </Command.List>
    </Command.Root>
    {/key}
  </Dialog.Content>
</Dialog.Root>
