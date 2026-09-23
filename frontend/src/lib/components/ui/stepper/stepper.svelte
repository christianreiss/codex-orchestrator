<script lang="ts">
  /**
   * Horizontal, navigable step rail. Deliberately dumb: the caller decides
   * which steps are done and reachable (by id, not by position), so hiding a
   * step never shifts another step's marks.
   *
   * Scrolls horizontally on narrow screens rather than wrapping into an
   * unreadable block.
   */
  import Check from "@lucide/svelte/icons/check";
  import { cn } from "$lib/utils/cn";
  import type { StepperStep } from "./index";

  type Props = {
    steps: StepperStep[];
    current: string;
    onSelect: (id: string) => void;
    label?: string;
    class?: string;
  };

  let { steps, current, onSelect, label = "Steps", class: className }: Props = $props();
</script>

<nav aria-label={label} class={cn("overflow-x-auto", className)}>
  <ol class="flex min-w-max items-center gap-1 text-xs">
    {#each steps as step, i (step.id)}
      {@const active = step.id === current}
      <li class="flex items-center gap-1">
        <button
          type="button"
          disabled={!step.reachable}
          onclick={() => step.reachable && onSelect(step.id)}
          aria-current={active ? "step" : undefined}
          class={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active && "bg-primary/10 font-medium text-foreground",
            !active && step.reachable && "text-muted-foreground hover:bg-muted hover:text-foreground",
            !step.reachable && "cursor-not-allowed text-muted-foreground/40",
          )}
        >
          <span
            class={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs",
              active && "border-primary bg-primary text-primary-foreground",
              step.done && !active && "border-success/40 bg-success-muted text-success-muted-foreground",
              !step.done && !active && "border-muted-foreground/30",
            )}
            aria-hidden="true"
          >
            {#if step.done && !active}
              <Check class="h-3 w-3" />
            {:else}
              {i + 1}
            {/if}
          </span>
          {step.label}
          {#if step.done && !active}<span class="sr-only">(done)</span>{/if}
        </button>
        {#if i < steps.length - 1}
          <span class="text-muted-foreground/30" aria-hidden="true">—</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
