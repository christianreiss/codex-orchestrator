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
  import { Section, StateBlock, DraftGuard, SaveState } from "$lib/components/page";
  import SegmentedControl from "$lib/components/page/SegmentedControl.svelte";
  import { policyIssues, usesCeilings, SPREAD_POINTS, STRATEGY_OPTIONS } from "./account-policy";

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
    <form class="grid max-w-xl gap-4" onsubmit={submit}>
      <fieldset class="grid gap-4" disabled={!canManage || $save.isPending}>
        <div class="grid gap-1.5">
          <span class="text-body-sm font-medium">Mode</span>
          <SegmentedControl
            label="Mode"
            value={draft.mode}
            options={[{ value: "auto", label: "Automatic", hint: "The server moves work between accounts" }, { value: "manual", label: "Manual", hint: "Only an operator or an agent switches" }]}
            onChange={(mode) => edit({ mode })}
          />
          <p class="text-body-sm text-muted-foreground">
            {draft.mode === "auto"
              ? "The server picks the account for new sessions and requests a switch when the strategy says so."
              : "Nothing switches on its own. New sessions still start on the account with the most headroom; moving a running scope is an explicit action (below, or the account-switch skill)."}
          </p>
        </div>

        {#if draft.mode === "auto"}
          <div class="grid gap-1.5">
            <span class="text-body-sm font-medium">Strategy</span>
            <SegmentedControl
              label="Strategy"
              value={draft.strategy}
              options={STRATEGY_OPTIONS}
              onChange={(strategy) => edit({ strategy })}
            />
            <p class="text-body-sm text-muted-foreground">{STRATEGY_OPTIONS.find((option) => option.value === draft!.strategy)?.explanation}</p>
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
            <div class="grid gap-4 sm:grid-cols-2">
              <FormField id={`${prefix}-soft`} label="Soft limit (%)" hint="Preferred ceiling per account, 50 to 99." error={issues.soft_ceiling}>
                {#snippet children(f)}
                  <Input id={`${prefix}-soft`} type="number" min={50} max={99} step={1} required value={draft!.soft_ceiling} oninput={(e) => edit({ soft_ceiling: e.currentTarget.valueAsNumber })} aria-describedby={f.describedBy} aria-invalid={f.invalid} />
                {/snippet}
              </FormField>
              <FormField id={`${prefix}-hard`} label="Hard limit (%)" hint="Used only when every account is past the soft limit." error={issues.hard_ceiling}>
                {#snippet children(f)}
                  <Input id={`${prefix}-hard`} type="number" min={50} max={100} step={1} required value={draft!.hard_ceiling} oninput={(e) => edit({ hard_ceiling: e.currentTarget.valueAsNumber })} aria-describedby={f.describedBy} aria-invalid={f.invalid} />
                {/snippet}
              </FormField>
            </div>
          {/if}

          <FormField id={`${prefix}-dwell`} label="Minimum dwell (minutes)" hint="After a switch the scope stays put at least this long, 0 to 240. Each switch rebuilds the prompt cache." error={issues.min_dwell_minutes} class="sm:max-w-48">
            {#snippet children(f)}
              <Input id={`${prefix}-dwell`} type="number" min={0} max={240} step={1} required value={draft!.min_dwell_minutes} oninput={(e) => edit({ min_dwell_minutes: e.currentTarget.valueAsNumber })} aria-describedby={f.describedBy} aria-invalid={f.invalid} />
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
