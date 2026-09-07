<script lang="ts">
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import type {
    ModelDefaultsCatalogEntry,
    ModelDefaultsEngine,
    ModelDefaultsValue,
  } from "$lib/api/types";
  import { modelDefaultsMutation, modelDefaultsQuery } from "$lib/api/settings";
  import SectionCard from "./SectionCard.svelte";

  type Props = {
    engine: ModelDefaultsEngine;
    headingLevel?: 2 | 3;
  };

  let { engine, headingLevel = 2 }: Props = $props();

  // Each tab mounts a dedicated, engine-fixed instance of this component.
  const stableEngine = untrack(() => engine);
  const engineLabel = stableEngine === "codex" ? "Codex" : "Claude";
  const query = modelDefaultsQuery(stableEngine);
  let model = $state("");
  let reasoningEffort = $state("");
  let lastSavedAt = $state<Date | null>(null);
  let baseline = $state<{ model: string; effort: string } | null>(null);

  const catalog = $derived($query.data?.catalog ?? []);
  const selectedEntry = $derived(
    catalog.find((entry) => entry.model === model) ?? null,
  );
  const efforts = $derived(selectedEntry?.persistent_efforts ?? []);
  const supportsReasoningEffort = $derived(efforts.length > 0);
  const dirty = $derived(baseline !== null && (model !== baseline.model || reasoningEffort !== baseline.effort));
  const remoteChanged = $derived(baseline !== null && $query.data !== undefined && (
    $query.data.model !== baseline.model || responseEffort($query.data) !== baseline.effort
  ));

  function defaultEffort(entry: ModelDefaultsCatalogEntry | null): string {
    if (!entry) return "";
    if (entry.default_effort && entry.persistent_efforts.includes(entry.default_effort)) {
      return entry.default_effort;
    }
    return entry.persistent_efforts[0] ?? "";
  }

  function responseEffort(value: ModelDefaultsValue): string {
    const entry = value.catalog.find((item) => item.model === value.model) ?? null;
    return value.reasoning_effort && entry?.persistent_efforts.includes(value.reasoning_effort)
        ? value.reasoning_effort
        : defaultEffort(entry);
  }

  function applyResponse(value: ModelDefaultsValue) {
    model = value.model;
    reasoningEffort = responseEffort(value);
    baseline = { model, effort: reasoningEffort };
  }

  $effect(() => {
    const data = $query.data;
    if (data) untrack(() => {
      // Live invalidations may arrive while an operator is editing. Adopt
      // remote defaults only while pristine; keep drafts visible otherwise.
      if (!baseline || !dirty) applyResponse(data);
    });
  });

  const mutation = modelDefaultsMutation(stableEngine, {
    onSuccess: (value) => {
      applyResponse(value);
      lastSavedAt = new Date();
      toast.success(`${engineLabel} fleet defaults saved`);
    },
    onError: (err) => toast.error(err.message),
  });

  function handleModelChange(value: unknown) {
    if (typeof value !== "string" || value === model) return;
    model = value;
    const entry = catalog.find((item) => item.model === value) ?? null;
    reasoningEffort = defaultEffort(entry);
  }

  function save() {
    if (!model) return;
    $mutation.mutate({
      model,
      reasoning_effort: supportsReasoningEffort ? reasoningEffort : null,
    });
  }

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess && !dirty) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id={`${stableEngine}-model-defaults`}
  title={`${engineLabel} fleet defaults`}
  description={`Default model and ${stableEngine === "claude" ? "effort level" : "reasoning effort"} for managed ${engineLabel} clients.`}
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
  {headingLevel}
>
  {#if $query.isError}
    <div class="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
      <p>{$query.error.message}</p>
      <Button variant="outline" size="sm" onclick={() => $query.refetch()} disabled={$query.isFetching}>Retry {engineLabel} defaults</Button>
    </div>
  {/if}
  {#if remoteChanged}
    <div class="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm" role="status">
      Fleet defaults changed elsewhere. Your edits are preserved; saving will replace the current fleet defaults.
      <Button variant="outline" size="sm" class="mt-2" onclick={() => $query.data && applyResponse($query.data)} disabled={$mutation.isPending}>Load latest defaults</Button>
    </div>
  {/if}

  <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
    <div class="grid min-w-0 gap-1.5">
      <Label for={`${stableEngine}-fleet-model`}>Model</Label>
      <Select.Root
        type="single"
        value={model}
        onValueChange={handleModelChange}
        disabled={$query.isPending || $query.isError || $mutation.isPending}
      >
        <Select.Trigger id={`${stableEngine}-fleet-model`}>
          <Select.Value placeholder={$query.isPending ? "Loading models…" : "Select model"}>
            {model}
          </Select.Value>
        </Select.Trigger>
        <Select.Content>
          {#each catalog as entry (entry.model)}
            <Select.Item value={entry.model} label={entry.model}>{entry.model}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>

    <div class="grid min-w-0 gap-1.5">
      <Label for={`${stableEngine}-fleet-reasoning-effort`}>{stableEngine === "claude" ? "Effort level" : "Reasoning effort"}</Label>
      {#if supportsReasoningEffort}
        <Select.Root
          type="single"
          value={reasoningEffort}
          onValueChange={(value) => {
            if (typeof value === "string") reasoningEffort = value;
          }}
          disabled={$query.isPending || $query.isError || $mutation.isPending}
        >
          <Select.Trigger id={`${stableEngine}-fleet-reasoning-effort`}>
            <Select.Value placeholder="Select effort">{reasoningEffort}</Select.Value>
          </Select.Trigger>
          <Select.Content>
            {#each efforts as effort (effort)}
              <Select.Item value={effort} label={effort}>{effort}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {:else}
        <Input
          id={`${stableEngine}-fleet-reasoning-effort`}
          value={$query.isPending ? "Loading effort options…" : "Not supported by this model"}
          disabled
        />
      {/if}
    </div>

    <Button
      size="sm"
      onclick={save}
      disabled={$query.isPending || $query.isError || $mutation.isPending || !selectedEntry}
    >
      {$mutation.isPending ? "Saving…" : "Save defaults"}
    </Button>
  </div>
  <div class="flex min-h-7 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
    <span>{stableEngine === "claude" ? "Synced to Claude Code settings. Host overrides take precedence." : "Synced to Codex configuration. Host overrides take precedence."}</span>
    {#if dirty}
      <div class="flex items-center gap-2" role="status">
        <span class="font-medium text-foreground">Unsaved changes</span>
        <Button variant="ghost" size="sm" disabled={$mutation.isPending} onclick={() => $query.data && applyResponse($query.data)}>Discard changes</Button>
      </div>
    {/if}
  </div>
</SectionCard>
