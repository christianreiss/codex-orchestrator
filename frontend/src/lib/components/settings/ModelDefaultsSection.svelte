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
  let initialized = false;

  const catalog = $derived($query.data?.catalog ?? []);
  const selectedEntry = $derived(
    catalog.find((entry) => entry.model === model) ?? null,
  );
  const efforts = $derived(selectedEntry?.persistent_efforts ?? []);
  const supportsReasoningEffort = $derived(efforts.length > 0);

  function defaultEffort(entry: ModelDefaultsCatalogEntry | null): string {
    if (!entry) return "";
    if (entry.default_effort && entry.persistent_efforts.includes(entry.default_effort)) {
      return entry.default_effort;
    }
    return entry.persistent_efforts[0] ?? "";
  }

  function applyResponse(value: ModelDefaultsValue) {
    model = value.model;
    const entry = value.catalog.find((item) => item.model === value.model) ?? null;
    reasoningEffort =
      value.reasoning_effort && entry?.persistent_efforts.includes(value.reasoning_effort)
        ? value.reasoning_effort
        : defaultEffort(entry);
    initialized = true;
  }

  $effect(() => {
    const data = $query.data;
    if (data && !initialized) applyResponse(data);
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
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id={`${stableEngine}-model-defaults`}
  title={`${engineLabel} fleet defaults`}
  description={`Default model and reasoning effort for managed ${engineLabel} clients.`}
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
  {headingLevel}
>
  {#if $query.isError}
    <p class="text-sm text-destructive">{$query.error.message}</p>
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
      <Label for={`${stableEngine}-fleet-reasoning-effort`}>Reasoning effort</Label>
      {#if supportsReasoningEffort}
        <Select.Root
          type="single"
          value={reasoningEffort}
          onValueChange={(value) => {
            if (typeof value === "string") reasoningEffort = value;
          }}
          disabled={$query.isPending || $mutation.isPending}
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
          value="Not supported by this model"
          disabled
        />
      {/if}
    </div>

    <Button
      size="sm"
      onclick={save}
      disabled={$query.isPending || $query.isError || $mutation.isPending || !selectedEntry}
    >
      Save defaults
    </Button>
  </div>
</SectionCard>
