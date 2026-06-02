<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  export type KeyValueRow = { key: string; value: string };

  type Props = {
    rows: KeyValueRow[];
    keyPlaceholder?: string;
    valuePlaceholder?: string;
    addLabel?: string;
    disabled?: boolean;
  };
  let {
    rows = $bindable([]),
    keyPlaceholder = "KEY",
    valuePlaceholder = "value",
    addLabel = "Add",
    disabled = false,
  }: Props = $props();

  function updateKey(index: number, key: string) {
    rows = rows.map((row, i) => (i === index ? { ...row, key } : row));
  }
  function updateValue(index: number, value: string) {
    rows = rows.map((row, i) => (i === index ? { ...row, value } : row));
  }
  function remove(index: number) {
    rows = rows.filter((_, i) => i !== index);
  }
  function add() {
    rows = [...rows, { key: "", value: "" }];
  }
</script>

<div class="space-y-2">
  {#each rows as row, i (i)}
    <div class="flex items-center gap-2">
      <Input
        class="w-1/3"
        value={row.key}
        placeholder={keyPlaceholder}
        {disabled}
        oninput={(e) => updateKey(i, e.currentTarget.value)}
      />
      <Input
        value={row.value}
        placeholder={valuePlaceholder}
        {disabled}
        oninput={(e) => updateValue(i, e.currentTarget.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        {disabled}
        onclick={() => remove(i)}
        aria-label="Remove entry"
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
