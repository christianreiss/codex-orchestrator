<script lang="ts">
  /**
   * The one select for filters and forms: a plain option list on the shared
   * `Select` (same trigger, popover and keyboard behaviour as everywhere else),
   * so a page does not mix native and custom controls. The trigger is a
   * `combobox` named by `aria-label` or a `<Label for={id}>`; options are
   * `option`s of its listbox.
   *
   * An empty-string value is a legitimate choice ("All statuses"): the list
   * primitive treats `""` as "nothing selected", so it travels as a private
   * sentinel and comes back as `""`.
   */
  import { Select as SelectPrimitive } from "bits-ui";
  import Trigger from "./select-trigger.svelte";
  import Content from "./select-content.svelte";
  import Item from "./select-item.svelte";
  import { cn } from "$lib/utils/cn";

  export type SimpleSelectOption = { value: string; label: string; disabled?: boolean };
  type Props = {
    value?: string;
    options: readonly SimpleSelectOption[];
    onValueChange?: (value: string) => void;
    placeholder?: string;
    id?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    disabled?: boolean;
    class?: string;
    contentClass?: string;
  };
  let { value = $bindable(""), options, onValueChange, placeholder = "Choose", id, disabled = false, class: className, contentClass, ...aria }: Props = $props();

  const EMPTY = "\u0000empty";
  const wire = (v: string) => (v === "" ? EMPTY : v);
  const current = $derived(options.find((option) => option.value === value));
  function choose(plain: string) {
    if (plain === value) return;
    onValueChange?.(plain);
    // With a handler the parent owns the value; without one, `bind:value` does.
    if (!onValueChange) value = plain;
  }
</script>

<!-- Controlled: the list shows `value` until the parent changes it, so a save that has not been confirmed yet never leaves the control ahead of the server. -->
<SelectPrimitive.Root
  type="single"
  bind:value={() => wire(value), (next) => choose(next === EMPTY ? "" : next)}
  {disabled}
>
  <Trigger {id} class={cn("w-auto min-w-[8rem] max-w-full gap-2", className)} {...aria}>
    <span class={cn("min-w-0 truncate", !current && "text-muted-foreground")}>{current?.label ?? placeholder}</span>
  </Trigger>
  <Content class={contentClass}>
    {#each options as option (option.value)}
      <Item value={wire(option.value)} label={option.label} disabled={option.disabled} />
    {/each}
  </Content>
</SelectPrimitive.Root>
