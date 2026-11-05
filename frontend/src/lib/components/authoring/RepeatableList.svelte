<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  type Props = {
    items: string[];
    /** Name of one entry; each input is named "<label> <number>". */
    label?: string;
    /** Visible caption above the entries, for callers without their own heading. */
    heading?: string;
    /** Id of the caller's visible heading for the whole list. */
    labelledby?: string;
    placeholder?: string;
    addLabel?: string;
    disabled?: boolean;
    onItemsChange?: (items: string[]) => void;
  };
  let {
    items = $bindable([]),
    label = "Item",
    heading,
    labelledby,
    placeholder = "",
    addLabel = "Add",
    disabled = false,
    onItemsChange,
  }: Props = $props();
  const headingId = $props.id();
  const groupLabel = $derived(labelledby ?? (heading ? headingId : undefined));

  function set(next: string[]) {
    items = next;
    onItemsChange?.(next);
  }
  function update(index: number, value: string) {
    set(items.map((item, i) => (i === index ? value : item)));
  }
  function remove(index: number) {
    set(items.filter((_, i) => i !== index));
  }
  function add() {
    set([...items, ""]);
  }
</script>

<div class="space-y-2" role={groupLabel ? "group" : undefined} aria-labelledby={groupLabel}>
  {#if heading}<p id={headingId} class="text-caption text-muted-foreground">{heading}</p>{/if}
  {#each items as item, i (i)}
    <div class="flex items-center gap-2">
      <Input
        value={item}
        {placeholder}
        aria-label={`${label} ${i + 1}`}
        {disabled}
        oninput={(e) => update(i, e.currentTarget.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        {disabled}
        onclick={() => remove(i)}
        aria-label="Remove item"
      >
        <Trash2 class="h-4 w-4 text-destructive" />
      </Button>
    </div>
  {/each}
  <Button type="button" variant="outline" size="sm" {disabled} onclick={add}>
    <Plus class="h-4 w-4" />
    {addLabel}
  </Button>
</div>
