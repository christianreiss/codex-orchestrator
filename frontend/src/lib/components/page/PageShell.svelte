<script lang="ts">
  import MutationNotice from "$lib/components/feedback/MutationNotice.svelte";
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

<svelte:head><title>{title} · Codex Orchestrator</title></svelte:head>

<div class={cn("flex min-w-0 w-full flex-col gap-4", maxWidth[width], className)}>
  <header class="flex flex-col items-stretch justify-between gap-3 md:flex-row md:items-start">
    <div class="min-w-0 flex-1">
      <h1 class="break-words text-xl font-semibold leading-[1.3] tracking-tight [overflow-wrap:anywhere]">{title}</h1>
      {#if description}<p class="mt-0.5 max-w-2xl text-body-sm text-muted-foreground">{description}</p>{/if}
    </div>
    <div class="flex min-w-0 flex-wrap items-center gap-2 md:max-w-[60%] md:justify-end">
      {#if toggle}
        <label class="flex items-center gap-2 text-body-sm text-muted-foreground">
          {toggle.label}
          <Switch checked={toggle.checked} disabled={toggle.disabled} onCheckedChange={toggle.onChange} aria-label={toggle.label} />
        </label>
      {/if}
      {@render actions?.()}
    </div>
  </header>
  <MutationNotice />
  {@render subheader?.()}
  {@render children?.()}
</div>
