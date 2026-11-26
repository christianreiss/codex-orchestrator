<script lang="ts">
  /**
   * Distribution policy of one engine's account pool: when the fleet moves work between accounts.
   * Saved explicitly (INT-3): the draft stays until the server confirms, and a background refresh
   * never overwrites unsaved edits.
   */
  import { untrack } from "svelte";
  import { derived, toStore } from "svelte/store";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { accountsApi, accountsKeys, type AccountPolicy, type PolicySpread } from "$lib/api/accounts";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { FormField } from "$lib/components/ui/form-field";
  import { ChoiceCard } from "$lib/components/ui/choice-card";
  import { RangeSlider } from "$lib/components/ui/slider";
  import { Section, StateBlock, DraftGuard, SaveState } from "$lib/components/page";
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import { ceilingsFrom, policyIssues, usesCeilings, SPREAD_POINTS, STRATEGY_OPTIONS } from "./account-policy";

  const MODE_OPTIONS = [
    { value: "auto", label: "Automatic", explanation: "The server picks the account for new sessions and requests a switch when the strategy says so." },
    { value: "manual", label: "Manual", explanation: "Nothing switches on its own. New sessions still start on the account with the most headroom; moving a running scope is an explicit action (below, or the account-switch skill)." },
  ] as const;

  type Props = { engine: Engine; canManage: boolean };
  let { engine, canManage }: Props = $props();

  const qc = useQueryClient();
  const query = createQuery(derived(toStore(() => engine), (e) => ({ queryKey: accountsKeys.policy(e), queryFn: () => accountsApi.policy(e) })));
  const live = $derived(engine === "claude");

  let draft = $state<AccountPolicy | null>(null);
  let baseline = $state("");
  let saved = $state(false);
  const dirty = $derived(draft !== null && JSON.stringify(draft) !== baseline);

  // Adopt the server value, but never over unsaved edits. Never read `draft` here: the effect
  // would depend on the object it just wrote and rerun forever (effect_update_depth_exceeded),
  // which froze the whole Accounts page after its first render.
  $effect(() => {
    const server = $query.data;
    if (!server || untrack(() => dirty)) return;
    const next = { ...server };
    draft = next;
    baseline = JSON.stringify(next);
  });

  const issues = $derived(draft ? policyIssues(draft) : {});
  const hasIssues = $derived(Object.keys(issues).length > 0);

  const save = createMutation({
    mutationFn: () => {
      const d = draft!;
      // Only what the chosen mode shows: a hidden, half-edited field must not fail the save.
      if (d.mode === "manual") return accountsApi.setPolicy(engine, { mode: "manual" });
      return accountsApi.setPolicy(engine, {
        mode: "auto",
        strategy: d.strategy,
        min_dwell_minutes: d.min_dwell_minutes,
        ...(usesCeilings(d.strategy) ? { soft_ceiling: d.soft_ceiling, hard_ceiling: d.hard_ceiling } : { spread: d.spread }),
      });
    },
    onSuccess: (policy) => {
      draft = { ...policy };
      baseline = JSON.stringify(draft);
      saved = true;
      qc.setQueryData(accountsKeys.policy(engine), policy);
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: accountsKeys.all() }); },
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!draft || hasIssues) return;
    saved = false;
    $save.mutate();
  }
  const edit = (change: Partial<AccountPolicy>) => { if (draft) { draft = { ...draft, ...change }; saved = false; $save.reset(); } };
  const prefix = $derived(`policy-${engine}`);
  const label = $derived(ENGINE_META[engine].label);
</script>

<DraftGuard {dirty} preserveOnSamePath />

<Section title={`${label} distribution policy`} description="Decides which account new sessions use and when running sessions move to another one.">
  {#if $query.isError && !draft}
    <StateBlock state="error" cause={$query.error} message={`Could not load the ${label} policy: ${$query.error.message}`} onRetry={() => $query.refetch()} />
  {:else if !draft}
    <StateBlock state="loading" />
  {:else}
    <form class="grid max-w-3xl gap-5" onsubmit={submit}>
      <fieldset class="grid gap-4" disabled={!canManage || $save.isPending}>
        <!-- Each choice is a card with its consequence on it: the difference between the options is the explanation. -->
        <div class="grid gap-2">
          <span id={`${prefix}-mode-label`} class="text-body-sm font-medium">Mode</span>
          <div role="radiogroup" aria-labelledby={`${prefix}-mode-label`} class="grid gap-2 sm:grid-cols-2">
            {#each MODE_OPTIONS as option (option.value)}
              <ChoiceCard title={option.label} description={option.explanation} checked={draft.mode === option.value} onSelect={() => edit({ mode: option.value })} />
            {/each}
          </div>
        </div>

        {#if draft.mode === "auto"}
          <div class="grid gap-2">
            <span id={`${prefix}-strategy-label`} class="text-body-sm font-medium">Strategy</span>
            <div role="radiogroup" aria-labelledby={`${prefix}-strategy-label`} class="grid gap-2 md:grid-cols-3">
              {#each STRATEGY_OPTIONS as option (option.value)}
                <ChoiceCard title={option.label} description={option.explanation} checked={draft.strategy === option.value} onSelect={() => edit({ strategy: option.value })} />
              {/each}
            </div>
          </div>

          {#if !usesCeilings(draft.strategy)}
            <div class="grid gap-1.5">
              <span class="text-body-sm font-medium">Band</span>
              <SegmentedControl
                label="Band"
                value={draft.spread}
                options={(["eng", "normal", "locker"] as PolicySpread[]).map((value) => ({ value, label: { eng: "Tight", normal: "Normal", locker: "Loose" }[value], hint: `${SPREAD_POINTS[value]} percentage points` }))}
                onChange={(spread) => edit({ spread })}
              />
              <p class="text-body-sm text-muted-foreground">Tight {SPREAD_POINTS.eng}, normal {SPREAD_POINTS.normal}, loose {SPREAD_POINTS.locker} percentage points of usage. Tighter bands even out accounts sooner but switch more often.</p>
            </div>
          {:else}
            <!-- One track, two thumbs: the soft limit can never pass the hard one. -->
            <div role="group" aria-labelledby={`${prefix}-limits-label`} aria-describedby={`${prefix}-limits-hint`} class="grid gap-2">
              <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <span id={`${prefix}-limits-label`} class="text-body-sm font-medium">Limits per account</span>
                <span class="flex gap-4 text-body-sm" data-testid="policy-limits">
                  <span><span class="text-muted-foreground">Soft</span> <span class="font-medium tabular-nums">{draft.soft_ceiling}%</span></span>
                  <span><span class="text-muted-foreground">Hard</span> <span class="font-medium tabular-nums">{draft.hard_ceiling}%</span></span>
                </span>
              </div>
              <RangeSlider
                value={[draft.soft_ceiling, draft.hard_ceiling]}
                min={50}
                max={100}
                labels={["Soft limit", "Hard limit"]}
                format={(value) => `${value}%`}
                scale={[50, 60, 70, 80, 90, 100]}
                disabled={!canManage || $save.isPending}
                onValueChange={(pair) => edit(ceilingsFrom(pair))}
              />
              <p id={`${prefix}-limits-hint`} class="text-body-sm text-muted-foreground">
                Each account is used up to the soft limit. Only when every account is past it does work continue, up to the hard limit. Arrow keys move a limit by one percent.
              </p>
              {#if issues.soft_ceiling || issues.hard_ceiling}
                <p class="text-body-sm text-destructive" role="alert">{issues.soft_ceiling ?? issues.hard_ceiling}</p>
              {/if}
            </div>
          {/if}

          <FormField id={`${prefix}-dwell`} label="Minimum dwell (minutes)" hint="After a switch the scope stays put at least this long, 0 to 240. Each switch rebuilds the prompt cache." error={issues.min_dwell_minutes}>
            {#snippet children(f)}
              <Input id={`${prefix}-dwell`} class="sm:max-w-48" type="number" min={0} max={240} step={1} required value={draft!.min_dwell_minutes} oninput={(e) => edit({ min_dwell_minutes: e.currentTarget.valueAsNumber })} aria-describedby={f.describedBy} aria-invalid={f.invalid} />
            {/snippet}
          </FormField>
        {/if}
      </fieldset>

      <p class="text-body-sm text-muted-foreground">
        {#if live}
          Running {label} sessions switch live: the change applies at the next turn boundary, without a restart.
        {:else}
          Live switching in running sessions currently works only for Claude. For {label} the policy decides which account a new launch picks.
        {/if}
      </p>

      {#if canManage}
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={$save.isPending || !dirty || hasIssues}>Save policy</Button>
          <SaveState pending={$save.isPending} error={$save.error} {dirty} {saved} />
        </div>
      {/if}
    </form>
  {/if}
</Section>
