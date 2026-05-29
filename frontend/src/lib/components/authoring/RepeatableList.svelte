<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  type Props = {
    items: string[];
    placeholder?: string;
    addLabel?: string;
    disabled?: boolean;
    onItemsChange?: (items: string[]) => void;
  };
  let {
    items = $bindable([]),
    placeholder = "",
    addLabel = "Add",
    disabled = false,
    onItemsChange,
  }: Props = $props();

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

<div class="space-y-2">
  {#each items as item, i (i)}
    <div class="flex items-center gap-2">
      <Input
        value={item}
        {placeholder}
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
