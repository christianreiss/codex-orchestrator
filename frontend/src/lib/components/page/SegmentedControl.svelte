<script lang="ts" generics="T extends string">
  /**
   * A one-level view switch: a few mutually exclusive ways to look at the same
   * page. Not tabs, so it never nests under the hub strip as a second tab row.
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

<div class={cn("inline-flex min-h-9 max-w-full flex-wrap items-center rounded-md bg-muted p-0.5", className)} role="group" aria-label={label}>
  {#each options as option (option.value)}
    <button
      type="button"
      title={option.hint}
      aria-pressed={value === option.value}
      class="min-h-8 rounded px-3 text-body-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground"
      onclick={() => onChange(option.value)}
    >{option.label}</button>
  {/each}
</div>
