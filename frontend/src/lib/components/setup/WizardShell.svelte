<script lang="ts">
  /**
   * Chrome for the first-run wizard, framed by AuthShell: the step rail, the progress line, and the
   * back / skip / next controls. Steps supply only their own body, and the
   * footer's primary button is the only commit action in the wizard — steps
   * expose `submit()`/`persist()` instead of rendering their own.
   *
   * The rail is navigable: an operator who wants to revisit the engine choice
   * four steps later should not have to click Back four times. Which steps are
   * done or reachable is decided by the page, by step id, so hiding a step
   * never shifts another's marks.
   */
  import type { Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { AuthShell } from "$lib/components/page";
  import { Stepper } from "$lib/components/ui/stepper";
  import type { SetupStep } from "$lib/api/setup";

  export interface WizardStepMeta {
    id: SetupStep;
    label: string;
    done: boolean;
    reachable: boolean;
  }

  type Props = {
    /** Visible steps only, in order. */
    steps: WizardStepMeta[];
    current: SetupStep;
    title: string;
    description?: string;
    /** Blocks Next. Steps 1-2 use this; later steps never do. */
    blocked?: boolean;
    blockedReason?: string;
    busy?: boolean;
    nextLabel?: string;
    /** Whether this step may be skipped. False for infrastructure, owner and the last step. */
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

  const index = $derived(Math.max(0, steps.findIndex((step) => step.id === current)));
  const total = $derived(steps.length);
  const canBack = $derived(index > 0);
  // Skip on the last step would do exactly what the primary button does.
  const isLast = $derived(index === total - 1);

  function back() {
    const previous = steps[index - 1];
    if (previous) onNavigate(previous.id);
  }
</script>

<AuthShell title="Set up Codex Orchestrator" description={`Step ${index + 1} of ${total}`} width="lg">
  <div class="space-y-4">
    <Stepper label="Setup steps" {steps} {current} onSelect={(id) => onNavigate(id as SetupStep)} />

    <div class="border-t pt-4">
      <h2 class="text-h3">{title}</h2>
      {#if description}<p class="mt-0.5 text-body-sm text-muted-foreground">{description}</p>{/if}
    </div>

    <div>{@render children()}</div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <div class="flex items-center gap-2">
        {#if canBack}
          <Button variant="ghost" size="sm" onclick={back} disabled={busy}>Back</Button>
        {/if}
        {#if actions}{@render actions()}{/if}
      </div>
      <div class="flex items-center gap-2">
        {#if blocked && blockedReason}
          <p class="text-body-sm text-muted-foreground">{blockedReason}</p>
        {/if}
        {#if skippable && !isLast}
          <Button variant="ghost" size="sm" onclick={onSkip} disabled={busy}>Skip</Button>
        {/if}
        <Button size="sm" onclick={onNext} disabled={blocked || busy}>{busy ? "Working…" : nextLabel}</Button>
      </div>
    </div>
  </div>
</AuthShell>
