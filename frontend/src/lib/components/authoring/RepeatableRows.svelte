<script lang="ts" generics="T extends object">
  import type { HTMLAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils/cn";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  // T is constrained to a plain object so patch() can immutably spread-merge
  // a partial update into it, matching HooksEditor's commit()-style discipline.
  type Props = HTMLAttributes<HTMLDivElement> & {
    rows: T[];
    newRow: () => T;
    row: Snippet<[item: T, index: number, patch: (partial: Partial<T>) => void]>;
    addLabel?: string;
    disabled?: boolean;
    min?: number;
    max?: number;
    class?: string;
  };

  let {
    rows = $bindable(),
    newRow,
    row,
    addLabel = "Add",
    disabled = false,
    min,
    max,
    class: className,
    ...rest
  }: Props = $props();

  function patch(index: number, partial: Partial<T>): void {
    rows = rows.map((item, i) => (i === index ? { ...item, ...partial } : item));
  }
  function remove(index: number): void {
    rows = [...rows.slice(0, index), ...rows.slice(index + 1)];
  }
  function add(): void {
    rows = [...rows, newRow()];
  }

  const canRemove = $derived(rows.length > (min ?? 0));
  const canAdd = $derived(max === undefined || rows.length < max);
</script>

<div class={cn("space-y-2", className)} {...rest}>
  {#each rows as item, i (i)}
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        {@render row(item, i, (partial) => patch(i, partial))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || !canRemove}
        onclick={() => remove(i)}
        aria-label="Remove row"
      >
        <Trash2 class="h-4 w-4 text-destructive" />
      </Button>
    </div>
  {/each}
  <Button type="button" variant="outline" size="sm" disabled={disabled || !canAdd} onclick={add}>
    <Plus class="h-4 w-4" />
    {addLabel}
  </Button>
</div>
