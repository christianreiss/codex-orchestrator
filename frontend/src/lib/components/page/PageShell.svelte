<script lang="ts">
  /**
   * The one page frame. Title row (name, one-line purpose, actions), optional
   * module switch, then content. Order rule for everything below it:
   * data first, actions second, settings behind a gear, destructive last.
   */
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils/cn";
  import { Switch } from "$lib/components/ui/switch";

  type Props = {
    title: string;
    description?: string;
    /** `narrow` for forms and documents, `wide` for tables and boards. */
    width?: "narrow" | "default" | "wide";
    /** A module on/off switch rendered in the header (never above the content). */
    toggle?: { label: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void };
    actions?: Snippet;
    /** Stat strip, tabs or filters that belong to the header block. */
    subheader?: Snippet;
    children?: Snippet;
    class?: string;
  };
  let { title, description, width = "default", toggle, actions, subheader, children, class: className }: Props = $props();

  const maxWidth = { narrow: "max-w-3xl", default: "max-w-6xl", wide: "max-w-none" } as const;
</script>

<div class={cn("mx-auto flex w-full flex-col gap-4", maxWidth[width], className)}>
  <header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-xl font-semibold leading-tight tracking-tight">{title}</h1>
      {#if description}<p class="mt-0.5 max-w-2xl text-body-sm text-muted-foreground">{description}</p>{/if}
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      {#if toggle}
        <label class="flex items-center gap-2 text-body-sm text-muted-foreground">
          {toggle.label}
          <Switch checked={toggle.checked} disabled={toggle.disabled} onCheckedChange={toggle.onChange} aria-label={toggle.label} />
        </label>
      {/if}
      {@render actions?.()}
    </div>
  </header>
  {@render subheader?.()}
  {@render children?.()}
</div>
