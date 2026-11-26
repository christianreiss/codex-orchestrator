<script lang="ts" generics="T extends string">
  /**
   * A one-level view switch: a few mutually exclusive ways to look at the same
   * page. Not tabs, so a page that has one never gets a second tab row.
   */
  import { cn } from "$lib/utils/cn";

  type Option = { value: T; label: string; hint?: string };
  type Props = {
    options: readonly Option[];
    value: T;
    label: string;
    onChange: (value: T) => void;
    class?: string;
  };
  let { options, value, label, onChange, class: className }: Props = $props();
</script>

<!-- w-fit: as a grid or stretched flex item it keeps its own width instead of an empty track beside the options. -->
<div class={cn("inline-flex min-h-9 w-fit max-w-full flex-wrap items-center gap-0.5 rounded-md border border-border/70 bg-muted/60 p-0.5", className)} role="group" aria-label={label}>
  {#each options as option (option.value)}
    <button
      type="button"
      title={option.hint}
      aria-pressed={value === option.value}
      class="min-h-8 rounded px-3 text-body-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm aria-pressed:ring-1 aria-pressed:ring-border"
      onclick={() => onChange(option.value)}
    >{option.label}</button>
  {/each}
</div>
