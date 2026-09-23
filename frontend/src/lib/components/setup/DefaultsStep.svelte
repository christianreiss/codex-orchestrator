<script lang="ts">
  /**
   * Fleet model defaults — and, more importantly, the step that turns MCP on.
   *
   * A fresh install has no row in `client_config_documents`. Without one,
   * `resolveManagedFeatureContext` sets `mcp = { enabled: false, reason:
   * 'config_missing' }` and skills, memory, projects and secrets all
   * short-circuit on that *before their own switches are read*. Turning
   * Projects on in the next step provably does nothing until this row exists.
   *
   * `POST /admin/model-defaults/codex` is the only thing that creates it. The
   * GET returns a plausible default that was never persisted, which is why the
   * console can look configured while every managed feature is dark.
   *
   * So codex is POSTed unconditionally — including when the operator answered
   * "neither" on the engines step, because this is about MCP activation and not
   * about credentials. Claude renders from an empty base already, so its POST
   * only happens when Claude is in play.
   *
   * The wizard's Skip calls `persist()` too, with whatever is selected — the
   * catalog defaults when nothing was touched — so skipping never leaves the
   * row missing.
   */
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { modelDefaultsQuery, modelDefaultsMutation } from "$lib/api/settings";
  import { invalidateSetup } from "$lib/api/setup";
  import type {
    ModelDefaultsCatalogEntry,
    ModelDefaultsEngine,
    ModelDefaultsValue,
  } from "$lib/api/types";
  import StepQueryState from "./StepQueryState.svelte";

  type Props = { engines: ("codex" | "claude")[] };
  let { engines }: Props = $props();

  const qc = useQueryClient();

  // Codex is always configured here; see the header comment.
  const targets = untrack((): ModelDefaultsEngine[] =>
    engines.includes("claude") ? ["codex", "claude"] : ["codex"],
  );

  const codexQuery = modelDefaultsQuery("codex");
  const claudeQuery = modelDefaultsQuery("claude");
  const codexMutation = modelDefaultsMutation("codex", {});
  const claudeMutation = modelDefaultsMutation("claude", {});

  type Draft = { model: string; effort: string; init: boolean };
  let drafts = $state<Record<ModelDefaultsEngine, Draft>>({
    codex: { model: "", effort: "", init: false },
    claude: { model: "", effort: "", init: false },
  });

  function defaultEffort(entry: ModelDefaultsCatalogEntry | null): string {
    if (!entry) return "";
    if (entry.default_effort && entry.persistent_efforts.includes(entry.default_effort)) {
      return entry.default_effort;
    }
    return entry.persistent_efforts[0] ?? "";
  }

  function effortFor(data: ModelDefaultsValue, model: string, current: string | null): string {
    const entry = data.catalog.find((item) => item.model === model) ?? null;
    return current && entry?.persistent_efforts.includes(current) ? current : defaultEffort(entry);
  }

  function seed(engine: ModelDefaultsEngine, data: ModelDefaultsValue | undefined): void {
    if (!data || drafts[engine].init) return;
    drafts[engine] = {
      model: data.model,
      effort: effortFor(data, data.model, data.reasoning_effort),
      init: true,
    };
  }

  $effect(() => seed("codex", $codexQuery.data));
  $effect(() => seed("claude", $claudeQuery.data));

  // ModelSelect only binds the model; keep the effort valid for whichever
  // model is now selected.
  $effect(() => {
    for (const engine of targets) {
      const data = engine === "codex" ? $codexQuery.data : $claudeQuery.data;
      const draft = drafts[engine];
      if (!data || !draft.init) continue;
      const entry = data.catalog.find((item) => item.model === draft.model) ?? null;
      if (entry && draft.effort && !entry.persistent_efforts.includes(draft.effort)) {
        draft.effort = defaultEffort(entry);
      } else if (entry && !draft.effort && entry.persistent_efforts.length > 0) {
        draft.effort = defaultEffort(entry);
      }
    }
  });

  const loading = $derived(
    $codexQuery.isLoading || (targets.includes("claude") && $claudeQuery.isLoading),
  );
  const loadError = $derived(
    $codexQuery.error?.message ??
      (targets.includes("claude") ? ($claudeQuery.error?.message ?? null) : null),
  );

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return $codexMutation.isPending || $claudeMutation.isPending;
  }

  async function save(engine: ModelDefaultsEngine): Promise<void> {
    const query = engine === "codex" ? $codexQuery : $claudeQuery;
    // Skip can land here before the catalog arrived; fetch it rather than
    // POSTing an empty model.
    const data = query.data ?? (await query.refetch()).data;
    if (!data) throw new Error(`Could not load ${engine === "codex" ? "Codex" : "Claude"} models`);
    const draft = drafts[engine];
    const model = draft.init && draft.model ? draft.model : data.model;
    const entry = data.catalog.find((item) => item.model === model) ?? null;
    const effort = draft.init && draft.model === model ? draft.effort : effortFor(data, model, data.reasoning_effort);
    const mutation = engine === "codex" ? $codexMutation : $claudeMutation;
    await mutation.mutateAsync({
      model,
      reasoning_effort: (entry?.persistent_efforts.length ?? 0) > 0 ? effort || null : null,
    });
  }

  /** Returns false when a write failed, so the wizard can hold position. */
  export async function persist(): Promise<boolean> {
    try {
      for (const engine of targets) await save(engine);
      invalidateSetup(qc);
      toast.success("Fleet defaults saved");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save fleet defaults");
      return false;
    }
  }
</script>

{#snippet engineBlock(engine: ModelDefaultsEngine, data: ModelDefaultsValue | undefined)}
  {@const label = engine === "codex" ? "Codex" : "Claude"}
  {@const catalog = data?.catalog ?? []}
  {@const entry = catalog.find((item) => item.model === drafts[engine].model) ?? null}
  {@const efforts = entry?.persistent_efforts ?? []}
  <div class="grid gap-3 sm:grid-cols-2">
    <div class="grid min-w-0 gap-1.5">
      <Label for="setup-{engine}-model">{label} model</Label>
      <ModelSelect
        id="setup-{engine}-model"
        label="{label} model"
        bind:value={drafts[engine].model}
        options={catalog.map((item) => ({ label: item.model, value: item.model }))}
        placeholder="Select model"
        class="w-full"
      />
    </div>
    <div class="grid min-w-0 gap-1.5">
      <Label for="setup-{engine}-effort">
        {engine === "claude" ? "Effort level" : "Reasoning effort"}
      </Label>
      {#if efforts.length > 0}
        <Select.Root
          type="single"
          value={drafts[engine].effort}
          onValueChange={(v) => {
            if (typeof v === "string") drafts[engine].effort = v;
          }}
        >
          <Select.Trigger id="setup-{engine}-effort" class="w-full">
            <Select.Value placeholder="Select effort">{drafts[engine].effort}</Select.Value>
          </Select.Trigger>
          <Select.Content>
            {#each efforts as effort (effort)}
              <Select.Item value={effort} label={effort}>{effort}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {:else}
        <p id="setup-{engine}-effort" class="flex h-9 items-center text-sm text-muted-foreground">
          Not supported by this model
        </p>
      {/if}
    </div>
  </div>
{/snippet}

<div class="space-y-5">
  <Alert variant="info">
    <AlertTitle>This step activates MCP for the fleet</AlertTitle>
    <AlertDescription>
      These values are baked into every managed host's config. Saving them also writes the
      fleet client config — which is what skills, memory, projects and secrets check before
      anything else. Until it exists, those features stay dark no matter how their own
      switches are set. Skipping saves the defaults shown here.
    </AlertDescription>
  </Alert>

  {#if loading || loadError}
    <StepQueryState
      {loading}
      error={loadError}
      subject="the model catalog"
      onRetry={() => {
        void $codexQuery.refetch();
        if (targets.includes("claude")) void $claudeQuery.refetch();
      }}
    />
  {:else}
    {@render engineBlock("codex", $codexQuery.data)}
    {#if targets.includes("claude")}
      <div class="border-t pt-4">
        {@render engineBlock("claude", $claudeQuery.data)}
      </div>
    {/if}
  {/if}

  <p class="text-xs text-muted-foreground">
    Per-host overrides and version pinning live on the Engines page afterwards.
  </p>
</div>
