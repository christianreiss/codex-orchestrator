<script lang="ts">
  /**
   * Page-level "is this whole module on" row: label + state sentence +
   * switch, one bordered surface. Distinct from settings/SettingRow (which
   * owns its own mutation + inline "Saved" flash for fleet-setting panels) —
   * here the caller's own mutation drives `checked`/`disabled` and handles
   * toast feedback, since these toggles gate an entire page's data.
   */
  import type { Snippet } from "svelte";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";

  type Props = {
    id: string;
    label: string;
    description: string;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (next: boolean) => void;
    notice?: Snippet;
    class?: string;
  };
  let {
    id,
    label,
    description,
    checked,
    disabled = false,
    onCheckedChange,
    notice,
    class: className = "",
  }: Props = $props();
</script>

<div class={`border-y border-border bg-card px-3 py-3 ${className}`}>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col">
      <Label for={id} class="text-sm font-medium">{label}</Label>
      <span class="text-xs text-muted-foreground">{description}</span>
    </div>
    <Switch {id} aria-label={label} {checked} {disabled} {onCheckedChange} />
  </div>
  {#if notice}
    <div class="mt-3 border-t border-border/60 pt-3">
      {@render notice()}
    </div>
  {/if}
</div>
