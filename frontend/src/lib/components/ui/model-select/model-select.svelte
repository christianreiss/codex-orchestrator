<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import type { ModelOption } from "$lib/constants/models";

  type Props = {
    /** Selected model id (bindable). */
    value: string;
    /** Options to offer; bind to the central model constants, never hardcode. */
    options: ModelOption[];
    /** Accessible name for the control (sets aria-label). Required. */
    label: string;
    placeholder?: string;
    /**
     * Render an editable combobox (text input + datalist suggestions) instead of
     * a strict dropdown, so operators can still pin a model not yet in the list
     * (wrappers self-test newer models). Pass a unique `id` so the datalist
     * associates correctly.
     */
    allowCustom?: boolean;
    /** Value to coalesce to when the dropdown emits an empty selection. */
    fallback?: string;
    id?: string;
    disabled?: boolean;
    class?: string;
  };

  let {
    value = $bindable(""),
    options,
    label,
    placeholder,
    allowCustom = false,
    fallback = "",
    id,
    disabled = false,
    class: className = "w-full max-w-xs",
  }: Props = $props();

  // Trigger shows the matching option's label; falls back to the raw value
  // (custom entries) or the placeholder.
  const display = $derived(options.find((o) => o.value === value)?.label ?? value);
  const listId = $derived(`${id ?? "model-select"}-options`);
</script>

{#if allowCustom}
  <Input
    {id}
    bind:value
    {placeholder}
    {disabled}
    list={listId}
    autocomplete="off"
    aria-label={label}
    class={className}
  />
  <datalist id={listId}>
    {#each options as o (o.value)}
      <option value={o.value}>{o.label}</option>
    {/each}
  </datalist>
{:else}
  <Select.Root type="single" {value} onValueChange={(v) => (value = v ?? fallback)} {disabled}>
    <Select.Trigger {id} class={className} aria-label={label}>
      <Select.Value {placeholder}>{display}</Select.Value>
    </Select.Trigger>
    <Select.Content>
      {#each options as o (o.value)}
        <Select.Item value={o.value} label={o.label}>{o.label}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
{/if}
