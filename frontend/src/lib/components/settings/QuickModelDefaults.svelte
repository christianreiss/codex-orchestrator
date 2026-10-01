<script lang="ts">
  import { engineLabel as labelForEngine, ENGINE_META } from "$lib/constants/engines";
  import { tick, untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import Check from "@lucide/svelte/icons/check";
  import { Button } from "$lib/components/ui/button";
  import { CODEX_MODELS, CLAUDE_MODEL_OPTIONS, GROK_MODEL_OPTIONS, REASONING_EFFORT_OPTIONS } from "$lib/constants/models";
  import { modelDefaultsMutation, modelDefaultsQuery, modelDefaultsQueryKey } from "$lib/api/settings";
  import type { ModelDefaultsEngine, ModelDefaultsUpdate, ModelDefaultsValue } from "$lib/api/types";

  let { engine }: { engine: ModelDefaultsEngine } = $props();
  const stableEngine = untrack(() => engine);
  const label = labelForEngine(stableEngine);
  const labels = stableEngine === "codex" ? CODEX_MODELS : stableEngine === "grok" ? GROK_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
  const query = modelDefaultsQuery(stableEngine);
  const mutation = modelDefaultsMutation(stableEngine);
  const client = useQueryClient();
  const queryKey = modelDefaultsQueryKey(stableEngine);

  let confirmed = $state<ModelDefaultsValue | null>(null);
  let model = $state("");
  let effort = $state<string | null>(null);
  let saving = $state(false);
  let needsRefresh = $state(false);
  let saveError = $state("");
  let saved = $state(false);
  let card: HTMLElement;

  const catalog = $derived(confirmed?.catalog ?? []);
  const selected = $derived(catalog.find((entry) => entry.model === model));
  const disabled = $derived(saving || needsRefresh || $query.isPending || $query.isError || !confirmed);

  function apply(value: ModelDefaultsValue) {
    confirmed = value;
    model = value.model;
    effort = value.reasoning_effort;
  }

  $effect(() => {
    const data = $query.data;
    if (!saving && !needsRefresh && !$query.isError && data) {
      untrack(() => {
        // Query observers batch notifications. Ignore a previous snapshot still
        // in the store after a write has already replaced the cached value.
        if (data !== client.getQueryData(queryKey)) return;
        if (confirmed && (confirmed.model !== data.model || confirmed.reasoning_effort !== data.reasoning_effort)) saved = false;
        apply(data);
      });
    }
  });

  async function refresh() {
    needsRefresh = true;
    const result = await $query.refetch();
    if (result.isSuccess) {
      apply(result.data);
      needsRefresh = false;
    }
  }

  async function save(update: ModelDefaultsUpdate, focused: HTMLInputElement) {
    if (disabled || !confirmed || (update.model === model && update.reasoning_effort === effort)) return;
    const previous = confirmed;
    saving = true;
    saved = false;
    saveError = "";
    model = update.model;
    effort = update.reasoning_effort ?? null;
    try {
      // A read begun before this write must never put the old selection back.
      await client.cancelQueries({ queryKey });
      const value = await $mutation.mutateAsync(update);
      // The shared mutation invalidates on settlement. Replace that overlapping
      // read with the authoritative write response.
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, value);
      apply(value);
      saved = true;
    } catch (error) {
      apply(previous);
      saveError = error instanceof Error ? error.message : "The settings could not be saved.";
      await client.cancelQueries({ queryKey });
      // A lost response may still have committed the write. Reconcile before
      // another selection; failed reads keep the controls locked.
      await refresh();
    } finally {
      saving = false;
      await tick();
      // Disabled native inputs lose focus. Restore only if the operator has
      // not moved on to another control or engine.
      if (document.activeElement === document.body || document.activeElement === focused) {
        card.querySelector<HTMLInputElement>(`input[name="${focused.name}"]:checked:not(:disabled)`)?.focus({ preventScroll: true });
      }
    }
  }

  function chooseModel(value: string, input: HTMLInputElement) {
    const entry = catalog.find((item) => item.model === value);
    if (entry) void save({ model: value, reasoning_effort: entry.default_effort }, input);
  }
</script>

<section bind:this={card} aria-labelledby={`${stableEngine}-quick-title`} class="min-w-0 rounded-2xl border bg-card p-5 sm:p-6">
  <header class="mb-6 flex items-center gap-3">
    <span class={`h-3 w-3 rounded-full ${ENGINE_META[stableEngine].color}`} aria-hidden="true"></span>
    <h2 id={`${stableEngine}-quick-title`} class="text-lg font-semibold">{label}</h2>
    <span class="ml-auto text-xs text-muted-foreground">Fleet defaults</span>
  </header>

  {#if $query.isPending}
    <p class="py-8 text-sm text-muted-foreground" role="status">Loading {label} defaults…</p>
  {:else}
    <fieldset {disabled} class="min-w-0">
      <legend class="mb-2 text-sm font-medium">Model</legend>
      <div class="grid grid-cols-2 gap-1.5 rounded-xl bg-muted p-1.5">
        {#each catalog as entry (entry.model)}
          <label class="relative min-w-0 cursor-pointer">
            <input type="radio" name={`${stableEngine}-quick-model`} value={entry.model} checked={model === entry.model}
              onchange={(event) => chooseModel(entry.model, event.currentTarget)} class="peer sr-only" />
            <span class="flex min-h-12 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:cursor-wait peer-disabled:opacity-60">
              <span class="min-w-0 break-words">{labels.find((item) => item.value === entry.model)?.label ?? entry.model}</span>
              <Check class={`h-4 w-4 shrink-0 ${model === entry.model ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
            </span>
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset {disabled} class="mt-6 min-w-0">
      <legend class="mb-2 text-sm font-medium">{stableEngine === "codex" ? "Reasoning effort" : "Effort level"}</legend>
      {#if selected && selected.persistent_efforts.length > 0}
        <div class="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1.5">
          {#each selected.persistent_efforts as value (value)}
            <label class="relative min-w-0 cursor-pointer">
              <input type="radio" name={`${stableEngine}-quick-effort`} {value} checked={effort === value}
                onchange={(event) => void save({ model, reasoning_effort: value }, event.currentTarget)} class="peer sr-only" />
              <span class="flex min-h-14 flex-col items-center justify-center rounded-lg px-1 py-2 text-sm font-medium text-muted-foreground transition-colors peer-checked:bg-background peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:cursor-wait peer-disabled:opacity-60">
                {REASONING_EFFORT_OPTIONS.find((item) => item.value === value)?.label ?? value}
                {#if value === selected.default_effort}<span class="text-[11px] font-normal">Default</span>{/if}
              </span>
            </label>
          {/each}
        </div>
      {:else if selected}
        <p class="rounded-xl bg-muted px-4 py-4 text-sm text-muted-foreground">No effort setting</p>
      {/if}
    </fieldset>
  {/if}

  <div class="mt-5 min-h-5 text-xs text-muted-foreground" role="status" aria-live="polite">
    {#if saving}Saving…{:else if needsRefresh && $query.isFetching}Refreshing saved settings…{:else if saved}Saved{:else}Selections save automatically.{/if}
  </div>
  {#if saveError}
    <p class="mt-2 text-sm text-destructive" role="alert">Could not save: {saveError}</p>
  {/if}
  {#if $query.isError}
    <div class="mt-2 space-y-2 text-sm text-destructive" role="alert">
      <p>Could not load the latest {label} defaults: {$query.error.message}</p>
      <Button variant="outline" size="sm" onclick={refresh} disabled={$query.isFetching || saving}>Retry {label} defaults</Button>
    </div>
  {/if}
</section>
