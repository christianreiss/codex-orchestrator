<script lang="ts">
  import { Switch } from "$lib/components/ui/switch";
  import { Label } from "$lib/components/ui/label";

  type Props = {
    id: string;
    label: string;
    description?: string;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (value: boolean) => void;
  };

  let { id, label, description, checked, disabled = false, onCheckedChange }: Props = $props();
</script>

<div class="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-4 py-3">
  <div class="min-w-0">
    <Label for={id} class="text-sm font-medium">{label}</Label>
    {#if description}
      <p class="mt-1 text-xs text-muted-foreground">{description}</p>
    {/if}
  </div>
  <Switch {id} {checked} {onCheckedChange} {disabled} aria-label={label} />
</div>
