<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Command from "$lib/components/ui/command";
  import { commandPalette } from "$lib/stores/command-palette";
  import { STATIC_COMMANDS, collectCommands, type PaletteCommand } from "./commands";

  let open = $state(false);
  let query = $state("");
  let commands = $state<PaletteCommand[]>(STATIC_COMMANDS);
  let dynamicLoading = $state(false);

  commandPalette.subscribe((s) => {
    open = s.open;
    if (s.open) query = "";
  });

  $effect(() => {
    if (!open) return;
    dynamicLoading = true;
    void collectCommands(query)
      .then((all) => {
        commands = all;
      })
      .finally(() => {
        dynamicLoading = false;
      });
  });

  function handleOpenChange(next: boolean) {
    if (next) commandPalette.open();
    else commandPalette.close();
  }

  // Group commands by their declared `group` for nicer rendering.
  const grouped = $derived.by(() => {
    const map = new Map<string, PaletteCommand[]>();
    for (const cmd of commands) {
      const list = map.get(cmd.group) ?? [];
      list.push(cmd);
      map.set(cmd.group, list);
    }
    return Array.from(map.entries());
  });
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="overflow-hidden p-0 sm:max-w-[560px]">
    <Dialog.Title class="sr-only">Command palette</Dialog.Title>
    <Dialog.Description class="sr-only">Search commands and pages.</Dialog.Description>
    <Command.Root shouldFilter={true} class="[&_[data-cmdk-input-wrapper]]:px-3">
      <Command.Input
        value={query}
        oninput={(e: Event) => (query = (e.currentTarget as HTMLInputElement).value)}
        placeholder="Type a command or search…"
      />
      <Command.List>
        <Command.Empty>No commands found.</Command.Empty>
        {#each grouped as [group, items] (group)}
          <Command.Group heading={group}>
            {#each items as cmd (cmd.id)}
              <Command.Item
                value={`${cmd.label} ${(cmd.keywords ?? []).join(" ")}`}
                onSelect={() => void cmd.run()}
              >
                {#if cmd.icon}
                  {@const Icon = cmd.icon}
                  <Icon class="h-4 w-4 text-muted-foreground" />
                {/if}
                <span class="flex-1">{cmd.label}</span>
                {#if cmd.hint}
                  <kbd class="ml-auto rounded border border-border bg-muted px-1.5 text-xs">
                    {cmd.hint}
                  </kbd>
                {/if}
              </Command.Item>
            {/each}
          </Command.Group>
        {/each}
      </Command.List>
    </Command.Root>
  </Dialog.Content>
</Dialog.Root>
