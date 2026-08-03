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
   */
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { modelDefaultsQuery, modelDefaultsMutation } from "$lib/api/settings";
  import type { ModelDefaultsCatalogEntry, ModelDefaultsEngine } from "$lib/api/types";

  type Props = { engines: ("codex" | "claude")[] };
  let { engines }: Props = $props();

  // Codex is always configured here; see the header comment.
  const targets = untrack((): ModelDefaultsEngine[] =>
    engines.includes("claude") ? ["codex", "claude"] : ["codex"],
  );

  const codexQuery = modelDefaultsQuery("codex");
  const claudeQuery = modelDefaultsQuery("claude");

  let codexModel = $state("");
  let codexEffort = $state("");
  let claudeModel = $state("");
  let claudeEffort = $state("");
  let codexInit = false;
  let claudeInit = false;

  function defaultEffort(entry: ModelDefaultsCatalogEntry | null): string {
    if (!entry) return "";
    if (entry.default_effort && entry.persistent_efforts.includes(entry.default_effort)) {
      return entry.default_effort;
    }
    return entry.persistent_efforts[0] ?? "";
  }

  $effect(() => {
    const data = $codexQuery.data;
    if (data && !codexInit) {
      codexModel = data.model;
      const entry = data.catalog.find((item) => item.model === data.model) ?? null;
      codexEffort =
        data.reasoning_effort && entry?.persistent_efforts.includes(data.reasoning_effort)
          ? data.reasoning_effort
          : defaultEffort(entry);
      codexInit = true;
    }
  });

  $effect(() => {
    const data = $claudeQuery.data;
    if (data && !claudeInit) {
      claudeModel = data.model;
      const entry = data.catalog.find((item) => item.model === data.model) ?? null;
      claudeEffort =
        data.reasoning_effort && entry?.persistent_efforts.includes(data.reasoning_effort)
          ? data.reasoning_effort
          : defaultEffort(entry);
      claudeInit = true;
    }
  });

  const codexMutation = modelDefaultsMutation("codex", {});
  const claudeMutation = modelDefaultsMutation("claude", {});

  const codexCatalog = $derived($codexQuery.data?.catalog ?? []);
  const claudeCatalog = $derived($claudeQuery.data?.catalog ?? []);
  const codexEntry = $derived(codexCatalog.find((e) => e.model === codexModel) ?? null);
  const claudeEntry = $derived(claudeCatalog.find((e) => e.model === claudeModel) ?? null);

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return $codexMutation.isPending || $claudeMutation.isPending;
  }

  /** Returns false when a write failed, so the wizard can hold position. */
  export async function persist(): Promise<boolean> {
    try {
      await $codexMutation.mutateAsync({
        model: codexModel,
        reasoning_effort: (codexEntry?.persistent_efforts.length ?? 0) > 0 ? codexEffort : null,
      });
      if (targets.includes("claude")) {
        await $claudeMutation.mutateAsync({
          model: claudeModel,
          reasoning_effort: (claudeEntry?.persistent_efforts.length ?? 0) > 0 ? claudeEffort : null,
        });
      }
      toast.success("Fleet defaults saved");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save fleet defaults");
      return false;
    }
  }
</script>

<div class="space-y-5">
  <Alert>
    <AlertTitle>This step activates MCP for the fleet</AlertTitle>
    <AlertDescription>
      These values are baked into every managed host's config. Saving them also writes the
      fleet client config — which is what skills, memory, projects and secrets check before
      anything else. Until it exists, those features stay dark no matter how their own
      switches are set.
    </AlertDescription>
  </Alert>

  <div class="space-y-1.5">
    <Label for="setup-codex-model">Codex model</Label>
    <Select.Root
      type="single"
      value={codexModel}
      onValueChange={(v) => {
        if (typeof v !== "string" || v === codexModel) return;
        codexModel = v;
        codexEffort = defaultEffort(codexCatalog.find((e) => e.model === v) ?? null);
      }}
    >
      <Select.Trigger id="setup-codex-model" class="w-full">
        {codexModel || "Loading…"}
      </Select.Trigger>
      <Select.Content>
        {#each codexCatalog as entry (entry.model)}
          <Select.Item value={entry.model}>{entry.model}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    {#if (codexEntry?.persistent_efforts.length ?? 0) > 0}
      <div class="pt-2">
        <Label for="setup-codex-effort">Reasoning effort</Label>
        <Select.Root
          type="single"
          value={codexEffort}
          onValueChange={(v) => {
            if (typeof v === "string") codexEffort = v;
          }}
        >
          <Select.Trigger id="setup-codex-effort" class="w-full">
            {codexEffort || "default"}
          </Select.Trigger>
          <Select.Content>
            {#each codexEntry?.persistent_efforts ?? [] as effort (effort)}
              <Select.Item value={effort}>{effort}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    {/if}
  </div>

  {#if targets.includes("claude")}
    <div class="space-y-1.5 border-t pt-4">
      <Label for="setup-claude-model">Claude model</Label>
      <Select.Root
        type="single"
        value={claudeModel}
        onValueChange={(v) => {
          if (typeof v !== "string" || v === claudeModel) return;
          claudeModel = v;
          claudeEffort = defaultEffort(claudeCatalog.find((e) => e.model === v) ?? null);
        }}
      >
        <Select.Trigger id="setup-claude-model" class="w-full">
          {claudeModel || "Loading…"}
        </Select.Trigger>
        <Select.Content>
          {#each claudeCatalog as entry (entry.model)}
            <Select.Item value={entry.model}>{entry.model}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}

  <p class="text-xs text-muted-foreground">
    Per-host overrides and version pinning live on the Engines page afterwards.
  </p>
</div>
