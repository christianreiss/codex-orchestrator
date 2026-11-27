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
  import { Switch } from "$lib/components/ui/switch";
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
  // Shown for engines that switch live, once the server knows pause rounds.
  const pausable = $derived(live && draft?.pause !== undefined);

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
      // Pausing is its own choice and applies in both modes; its durations are sent only while it is on.
      const pausing = !pausable ? {} : d.pause === "on" ? { pause: "on" as const, pause_after_seconds: d.pause_after_seconds, pause_hold_seconds: d.pause_hold_seconds } : { pause: "off" as const };
      if (d.mode === "manual") return accountsApi.setPolicy(engine, { mode: "manual", ...pausing });
      return accountsApi.setPolicy(engine, {
        ...pausing,
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

        {#if pausable}
          <!-- Its own choice, in both modes: an operator's own switch request is paused for as well. -->
          <div class="grid gap-3 border-t pt-4">
            <div class="flex items-start justify-between gap-4">
              <div class="grid gap-1">
                <span id={`${prefix}-pause-label`} class="text-body-sm font-medium">Pause sessions for a switch</span>
                <p id={`${prefix}-pause-hint`} class="text-body-sm text-muted-foreground">
                  A switch needs a moment when no session of that user on that host is talking to the model. With several busy sessions that moment may not come for hours. When this is on, the server asks every session to wait at its next step, switches, and lets them continue. Sessions started before this was available cannot be paused, and their scope keeps waiting.
                </p>
              </div>
              <Switch
                checked={draft.pause === "on"}
                onCheckedChange={(on) => edit({ pause: on ? "on" : "off" })}
                disabled={!canManage || $save.isPending}
                aria-labelledby={`${prefix}-pause-label`}
                aria-describedby={`${prefix}-pause-hint`}
              />
            </div>
            {#if draft.pause === "on"}
              <div class="grid gap-4 sm:grid-cols-2">
                <FormField id={`${prefix}-pause-after`} label="Wait for a natural gap first (seconds)" hint="How long a pending switch waits for a gap between turns before sessions are paused, 0 to 3600. An account at its limit is not waited for." error={issues.pause_after_seconds}>
                  {#snippet children(f)}
                    <Input id={`${prefix}-pause-after`} class="sm:max-w-48" type="number" min={0} max={3600} step={1} required value={draft!.pause_after_seconds} oninput={(e) => edit({ pause_after_seconds: e.currentTarget.valueAsNumber })} aria-describedby={f.describedBy} aria-invalid={f.invalid} />
                  {/snippet}
                </FormField>
                <FormField id={`${prefix}-pause-hold`} label="Hold a session at most (seconds)" hint="The longest any session waits, 30 to 300. If not every session has paused by then, all continue and the switch is tried again later." error={issues.pause_hold_seconds}>
                  {#snippet children(f)}
                    <Input id={`${prefix}-pause-hold`} class="sm:max-w-48" type="number" min={30} max={300} step={1} required value={draft!.pause_hold_seconds} oninput={(e) => edit({ pause_hold_seconds: e.currentTarget.valueAsNumber })} aria-describedby={f.describedBy} aria-invalid={f.invalid} />
                  {/snippet}
                </FormField>
              </div>
            {/if}
          </div>
        {/if}
      </fieldset>

      <p class="text-body-sm text-muted-foreground">
        {#if live}
          Running {label} sessions switch live, without a restart: at the next gap between turns{draft.pause === "on" ? ", or while the sessions are paused for it" : ""}.
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
