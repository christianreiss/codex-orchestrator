<script lang="ts">
  /**
   * Searchable combobox over an engine's key list. Plaintext is never
   * available for existing keys, so this only ever resolves to a record
   * (name + prefix) -- callers compose a placeholder line from that.
   */
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import * as Popover from "$lib/components/ui/popover";
  import * as Command from "$lib/components/ui/command";
  import { Button } from "$lib/components/ui/button";
  import type { AdminApiKey } from "$lib/api/types";

  type Props = {
    keys: AdminApiKey[];
    value: number | null;
    loading?: boolean;
    placeholder?: string;
    onSelect: (record: AdminApiKey) => void;
  };
  let { keys, value, loading = false, placeholder = "Select a key…", onSelect }: Props = $props();

  let open = $state(false);
  const selected = $derived(keys.find((k) => k.id === value) ?? null);
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        type="button"
        variant="outline"
        class="w-full max-w-lg justify-between font-normal"
        disabled={loading}
      >
        <span class="truncate">
          {#if loading}
            Loading keys…
          {:else if selected}
            {selected.name} <span class="text-muted-foreground">· {selected.key_prefix}</span>
          {:else}
            {placeholder}
          {/if}
        </span>
        <ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-80 max-w-[90vw] p-0" align="start">
    <Command.Root>
      <Command.Input placeholder="Search by name or prefix…" />
      <Command.List>
        <Command.Empty>No keys found.</Command.Empty>
        <Command.Group>
          {#each keys as record (record.id)}
            <Command.Item
              value={`${record.name} ${record.key_prefix} ${record.id}`}
              onSelect={() => {
                onSelect(record);
                open = false;
              }}
            >
              <span class="flex-1 truncate">{record.name}</span>
              <code class="shrink-0 text-xs text-muted-foreground">{record.key_prefix}</code>
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
