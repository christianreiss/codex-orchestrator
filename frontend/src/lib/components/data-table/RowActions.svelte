<script lang="ts">
  /**
   * A row-level "⋯" overflow menu — isolates a destructive action from
   * benign ones via a separator and destructive coloring, rather than
   * sitting inline in the same button row.
   */
  import type { Component } from "svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";

  export type RowAction = {
    label: string;
    icon?: Component;
    onClick: () => void;
    destructive?: boolean;
    disabled?: boolean;
    /**
     * Why the action is unavailable. A greyed-out control with no explanation
     * is a support ticket; naming the missing capability is an instruction.
     */
    reason?: string;
  };

  type Props = {
    actions: RowAction[];
    /** aria-label for the trigger button; defaults to "Row actions". */
    label?: string;
  };
  let { actions, label = "Row actions" }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    aria-label={label}
  >
    <Ellipsis class="h-4 w-4" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-48">
    {#each actions as action, i (action.label)}
      {#if action.destructive && i > 0}
        <DropdownMenu.Separator />
      {/if}
      <DropdownMenu.Item
        onclick={action.onClick}
        disabled={action.disabled}
        title={action.reason}
        class={action.destructive
          ? "text-destructive focus:bg-destructive-muted focus:text-destructive"
          : undefined}
      >
        {#if action.icon}
          <action.icon class="h-4 w-4" />
        {/if}
        {action.label}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
