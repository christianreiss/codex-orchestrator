<script lang="ts">
  /** Advanced: per-host exceptions (model / version / agents document overrides). Blank inherits the fleet default. */
  import { useQueryClient } from "@tanstack/svelte-query";
  import { Button } from "$lib/components/ui/button";
  import {
    createAgentsVersionMutation,
    createClaudeVersionMutation,
    createCodexVersionMutation,
    createGrokVersionMutation,
    createModelOverrideMutation,
    hostEngines,
  } from "$lib/api/hosts";
  import { modelDefaultsQuery } from "$lib/api/settings";
  import { CLAUDE_MODEL_OPTIONS, CODEX_MODELS, GROK_MODEL_OPTIONS, REASONING_EFFORT_OPTIONS } from "$lib/constants/models";
  import type { HostDetailResponse } from "$lib/api/types";
  import EnginePanel from "../EnginePanel.svelte";
  import InputDialog from "../InputDialog.svelte";
  import OverridePopover from "../OverridePopover.svelte";
  import { runQuiet } from "./actions";

  type Props = { host: HostDetailResponse["host"]; overview: HostDetailResponse["overview"] | undefined; id: string };
  let { host, overview, id }: Props = $props();

  const qc = useQueryClient();
  const codexVersion = createCodexVersionMutation(qc);
  const claudeVersion = createClaudeVersionMutation(qc);
  const grokVersion = createGrokVersionMutation(qc);
  const modelOverride = createModelOverrideMutation(qc);
  const agentsVersion = createAgentsVersionMutation(qc);
  const grokDefaults = modelDefaultsQuery("grok");
  const codexDefaults = modelDefaultsQuery("codex");

  const engines = $derived(hostEngines(host));
  const digest = (value: string | null | undefined) => (value ? value.slice(0, 16) + "…" : "—");
  const grokModel = $derived(host.grok_model_override ?? $grokDefaults.data?.model ?? "grok-4.7");
  const grokEfforts = $derived(
    ($grokDefaults.data?.catalog.find((model) => model.model === grokModel)?.persistent_efforts
      ?? (grokModel === "grok-4.5" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"]))
      .map((value) => ({ value, label: REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label ?? value })),
  );
  const codexModels = $derived(CODEX_MODELS.map(option => {
    const minimum = $codexDefaults.data?.catalog?.find(entry => entry.model === option.value)?.min_cli_version
      ?? (option.value === "gpt-6.1-terra" ? "0.159.0" : undefined);
    const observed = host.client_version?.match(/\b(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
    const required = minimum?.split(".").map(Number);
    const supported = !minimum || Boolean(observed && required && (
      Number(observed[1]) > required[0] || Number(observed[1]) === required[0] && (
      Number(observed[2]) > required[1] || Number(observed[2]) === required[1] && (
      Number(observed[3]) > required[2] || Number(observed[3]) === required[2] && !observed[4]))));
    return { ...option, disabled: !supported };
  }));
  const codexUpgradeNeeded = $derived(codexModels.some(option => option.disabled));
  // Claude's documented per-model floors arrive in the catalog; the observed
  // version is the host's reported Claude CLI, never Codex's or a desired pin.
  const claudeDefaults = modelDefaultsQuery("claude");
  const claudeModels = $derived(CLAUDE_MODEL_OPTIONS.map(option => {
    const minimum = $claudeDefaults.data?.catalog?.find(entry => entry.model === option.value)?.min_cli_version;
    const observed = host.claude_client_version?.match(/\b(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
    const required = minimum?.split(".").map(Number);
    const supported = !minimum || Boolean(observed && required && (
      Number(observed[1]) > required[0] || Number(observed[1]) === required[0] && (
      Number(observed[2]) > required[1] || Number(observed[2]) === required[1] && (
      Number(observed[3]) > required[2] || Number(observed[3]) === required[2] && !observed[4]))));
    return { ...option, disabled: !supported };
  }));
  const claudeUpgradeNeeded = $derived(claudeModels.some(option => option.disabled));
  let agentsOpen = $state(false);

  const model = (engine: "codex" | "claude" | "grok") => (value: string | null) => runQuiet($modelOverride.mutateAsync({ id, engine, model: value }));
  const effort = (engine: "codex" | "grok") => (value: string | null) => runQuiet($modelOverride.mutateAsync({ id, engine, reasoning_effort: value }));
</script>

<div>
  <h3 class="text-h3">Per-host exceptions</h3>
  <p class="mb-2 text-body-sm text-muted-foreground">Host overrides. Clearing one makes the host follow the fleet default again.</p>
  <div class="grid gap-x-8 gap-y-4 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
    {#if engines.includes("codex")}
      <EnginePanel engine="codex" digest={digest(host.canonical_digest)}>
        <OverridePopover label="Version" override={host.client_version_override} inheritedValue={host.client_version} inheritedLabel="detected" placeholder={overview?.versions.client_version ?? "0.30.0"} pending={$codexVersion.isPending} onSave={(v) => runQuiet($codexVersion.mutateAsync({ id, version: v }))} />
        <OverridePopover label="Model" override={host.model_override} options={codexModels} pending={$modelOverride.isPending} onSave={model("codex")} />
        {#if codexUpgradeNeeded}
          <p class="text-body-sm text-muted-foreground">GPT-6.1 Terra requires Codex CLI 0.159.0 or newer. Run cdx update on this host, or cron run to report an installed version.</p>
        {/if}
        <OverridePopover label="Reasoning effort" override={host.reasoning_effort_override} options={REASONING_EFFORT_OPTIONS} pending={$modelOverride.isPending} onSave={effort("codex")} />
      </EnginePanel>
    {/if}
    {#if engines.includes("claude")}
      <EnginePanel engine="claude" digest={digest(host.claude_canonical_digest)}>
        <OverridePopover label="Version" override={host.claude_client_version_override} inheritedValue={host.claude_client_version} inheritedLabel="detected" placeholder={overview?.versions.claude_version ?? "1.0.0"} pending={$claudeVersion.isPending} onSave={(v) => runQuiet($claudeVersion.mutateAsync({ id, version: v }))} />
        <OverridePopover label="Model" override={host.claude_model_override} options={claudeModels} pending={$modelOverride.isPending} onSave={model("claude")} />
        {#if claudeUpgradeNeeded}
          <p class="text-body-sm text-muted-foreground">Some Claude models need a newer Claude Code than this host reports. Run clx update on this host, or cron run to report an installed version.</p>
        {/if}
      </EnginePanel>
    {/if}
    {#if engines.includes("grok")}
      <EnginePanel engine="grok" digest={digest(host.grok_canonical_digest)}>
        <OverridePopover label="Version" override={host.grok_client_version_override ?? null} inheritedValue={host.grok_client_version} inheritedLabel="detected" placeholder={overview?.versions.grok_version ?? "1.0.50"} pending={$grokVersion.isPending} onSave={(v) => runQuiet($grokVersion.mutateAsync({ id, version: v }))} />
        <OverridePopover label="Model" override={host.grok_model_override ?? null} options={GROK_MODEL_OPTIONS} pending={$modelOverride.isPending} onSave={model("grok")} />
        <OverridePopover label="Reasoning effort" override={host.grok_reasoning_effort_override ?? null} options={grokEfforts} pending={$modelOverride.isPending} onSave={effort("grok")} />
      </EnginePanel>
    {/if}
  </div>
  <div class="mt-2 flex items-center justify-between gap-3 border-b py-2.5">
    <div class="min-w-0">
      <div class="text-body">Agent rules document</div>
      <div class="truncate font-mono text-caption text-muted-foreground">{host.agents_document_id_override ?? "Follows the fleet default"}</div>
    </div>
    <Button variant="outline" size="sm" onclick={() => (agentsOpen = true)}>Edit</Button>
  </div>
</div>

<InputDialog
  bind:open={agentsOpen}
  onOpenChange={(v) => (agentsOpen = v)}
  title="Agent rules document"
  description="Pin a specific agent-rules (agents) document by id for this host. Empty follows the fleet default."
  label="Agents document id"
  placeholder="42"
  initialValue={host.agents_document_id_override ? String(host.agents_document_id_override) : ""}
  onSubmit={(v) => {
    const parsed = v === null || v === "" ? null : Number.parseInt(v, 10);
    return runQuiet($agentsVersion.mutateAsync({ id, document_id: Number.isFinite(parsed) ? parsed : null }));
  }}
/>
