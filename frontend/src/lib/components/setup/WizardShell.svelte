<script lang="ts">
  /**
   * Chrome for the first-run wizard: the step rail, the progress line, and the
   * back / skip / next controls. Steps supply only their own body.
   *
   * Built from card/separator/badge/button because there is no stepper
   * primitive in `$lib/components/ui` and one wizard does not justify adding a
   * dependency.
   *
   * The rail is navigable: an operator who wants to revisit the engine choice
   * four steps later should not have to click Back four times. Steps ahead of
   * the furthest one reached stay disabled, so it reads as progress rather than
   * a menu.
   */
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Separator } from "$lib/components/ui/separator";
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import { cn } from "$lib/utils/cn";
  import type { SetupStep } from "$lib/api/setup";

  export interface WizardStepMeta {
    id: SetupStep;
    label: string;
    /** Hidden from the rail entirely — used to drop `auth` when engines = none. */
    skipped?: boolean;
  }

  type Props = {
    steps: WizardStepMeta[];
    current: SetupStep;
    /** Highest step index the operator has reached; gates rail navigation. */
    furthest: number;
    title: string;
    description?: string;
    /** Blocks Next. Steps 1-2 use this; later steps never do. */
    blocked?: boolean;
    blockedReason?: string;
    busy?: boolean;
    nextLabel?: string;
    /** Whether this step may be skipped. False for infrastructure and owner. */
    skippable?: boolean;
    onNavigate: (step: SetupStep) => void;
    onNext: () => void;
    onSkip: () => void;
    children: Snippet;
    /** Optional extra controls rendered left of Skip/Next. */
    actions?: Snippet;
  };

  let {
    steps,
    current,
    furthest,
    title,
    description,
    blocked = false,
    blockedReason,
    busy = false,
    nextLabel = "Continue",
    skippable = true,
    onNavigate,
    onNext,
    onSkip,
    children,
    actions,
  }: Props = $props();

  const visible = $derived(steps.filter((step) => !step.skipped));
  const index = $derived(Math.max(0, visible.findIndex((step) => step.id === current)));
  const total = $derived(visible.length);
  const canBack = $derived(index > 0);

  function back() {
    const previous = visible[index - 1];
    if (previous) onNavigate(previous.id);
  }
</script>

<main class="min-h-screen bg-muted/20 px-4 py-8 sm:py-12">
  <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
    <div class="flex items-center gap-3">
      <BrandMark />
      <div>
        <h1 class="text-xl font-semibold">Set up Codex Orchestrator</h1>
        <p class="text-sm text-muted-foreground">
          Step {index + 1} of {total}
        </p>
      </div>
    </div>

    <!-- Rail. Horizontal and scrollable on narrow screens rather than wrapping
         into an unreadable block. -->
    <nav aria-label="Setup steps" class="overflow-x-auto">
      <ol class="flex min-w-max items-center gap-1 text-xs">
        {#each visible as step, i (step.id)}
          {@const done = i < furthest}
          {@const active = step.id === current}
          {@const reachable = i <= furthest}
          <li class="flex items-center gap-1">
            <button
              type="button"
              disabled={!reachable}
              onclick={() => reachable && onNavigate(step.id)}
              aria-current={active ? "step" : undefined}
              class={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors",
                active && "bg-primary/10 font-medium text-foreground",
                !active && reachable && "text-muted-foreground hover:bg-muted hover:text-foreground",
                !reachable && "cursor-not-allowed text-muted-foreground/40",
              )}
            >
              <span
                class={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                  active && "border-primary bg-primary text-primary-foreground",
                  done && !active && "border-primary/40 bg-primary/10 text-foreground",
                  !done && !active && "border-muted-foreground/30",
                )}
                aria-hidden="true"
              >
                {done && !active ? "✓" : i + 1}
              </span>
              {step.label}
            </button>
            {#if i < visible.length - 1}
              <span class="text-muted-foreground/30" aria-hidden="true">—</span>
            {/if}
          </li>
        {/each}
      </ol>
    </nav>

    <div class="rounded-xl border bg-card shadow-sm">
      <div class="space-y-1 p-6 pb-4">
        <h2 class="text-lg font-semibold">{title}</h2>
        {#if description}
          <p class="text-sm text-muted-foreground">{description}</p>
        {/if}
      </div>
      <Separator />
      <div class="p-6">
        {@render children()}
      </div>
      <Separator />
      <div class="flex flex-wrap items-center justify-between gap-3 p-4">
        <div class="flex items-center gap-2">
          {#if canBack}
            <Button variant="ghost" size="sm" onclick={back} disabled={busy}>Back</Button>
          {/if}
          {#if actions}{@render actions()}{/if}
        </div>
        <div class="flex items-center gap-2">
          {#if blocked && blockedReason}
            <p class="text-xs text-muted-foreground">{blockedReason}</p>
          {/if}
          {#if skippable}
            <Button variant="ghost" size="sm" onclick={onSkip} disabled={busy}>Skip</Button>
          {/if}
          <Button size="sm" onclick={onNext} disabled={blocked || busy}>
            {busy ? "Working…" : nextLabel}
          </Button>
        </div>
      </div>
    </div>
  </div>
</main>
