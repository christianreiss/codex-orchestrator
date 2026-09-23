<script lang="ts">
  /**
   * A selectable card: title, optional description, optional trailing badge.
   *
   * `mode="radio"` for one-of-many (wrap the set in `role="radiogroup"`),
   * `mode="checkbox"` for independent toggles. Either way it is a real button
   * with `aria-checked`, so Space/Enter toggle it and screen readers announce
   * the state; arrow-key roving is left to native tab order.
   */
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";

  type Props = {
    title: string;
    description?: string;
    checked: boolean;
    mode?: "radio" | "checkbox";
    disabled?: boolean;
    /** Trailing content in the title row — a Badge, a `<kbd>` hint. */
    badge?: Snippet;
    size?: "default" | "sm";
    id?: string;
    class?: string;
    onSelect: () => void;
  };

  let {
    title,
    description,
    checked,
    mode = "radio",
    disabled = false,
    badge,
    size = "default",
    id,
    class: className,
    onSelect,
  }: Props = $props();
</script>

<button
  type="button"
  {id}
  role={mode}
  aria-checked={checked}
  {disabled}
  onclick={() => !disabled && onSelect()}
  class={cn(
    "flex w-full flex-col items-start gap-0.5 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    size === "sm" ? "p-2.5" : "p-4",
    checked ? "border-primary bg-primary/5" : "border-input hover:bg-muted/50",
    className,
  )}
>
  <span class="flex w-full items-center justify-between gap-2">
    <span class="flex items-center gap-2 text-sm font-medium">
      <span
        aria-hidden="true"
        class={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center border",
          mode === "radio" ? "rounded-full" : "rounded-sm",
          checked ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
      >
        {#if checked}
          <span
            class={cn(
              "bg-primary-foreground",
              mode === "radio" ? "h-1.5 w-1.5 rounded-full" : "h-2 w-2 rounded-[1px]",
            )}
          ></span>
        {/if}
      </span>
      {title}
    </span>
    {#if badge}{@render badge()}{/if}
  </span>
  {#if description}
    <span class="pl-6 text-xs text-muted-foreground">{description}</span>
  {/if}
</button>
