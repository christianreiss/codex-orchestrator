<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import {
    claudeSettingsMutation,
    claudeSettingsQuery,
    claudeStateMutation,
    claudeStateQuery,
    claudeVersionMutation,
    claudeVersionQuery,
  } from "$lib/api/settings";

  /* ---------------- engine toggle ---------------- */
  const stateQ = claudeStateQuery();
  let lastSavedAt = $state<Date | null>(null);
  const stateM = claudeStateMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Claude engine updated");
    },
    onError: (err) => toast.error(err.message),
  });

  /* ---------------- settings (model + max tokens) ---------------- */
  const settingsQ = claudeSettingsQuery();
  const settingsM = claudeSettingsMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Claude settings saved");
    },
    onError: (err) => toast.error(err.message),
  });

  let modelInput = $state("");
  let maxTokensInput = $state<number>(8192);
  let initializedSettings = false;

  $effect(() => {
    const d = $settingsQ.data;
    if (d && !initializedSettings) {
      modelInput = d.default_model;
      maxTokensInput = d.max_tokens;
      initializedSettings = true;
    }
  });

  function saveSettings() {
    $settingsM.mutate({
      default_model: modelInput.trim(),
      max_tokens: Number(maxTokensInput),
    });
  }

  /* ---------------- claude version ---------------- */
  const versionQ = claudeVersionQuery();
  const versionM = claudeVersionMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Claude version saved");
    },
    onError: (err) => toast.error(err.message),
  });

  let versionInput = $state("");
  let lockedInput = $state(false);
  let initializedVersion = false;

  $effect(() => {
    const d = $versionQ.data;
    if (d && !initializedVersion) {
      versionInput = d.version ?? "";
      lockedInput = d.locked;
      initializedVersion = true;
    }
  });

  function saveVersion() {
    $versionM.mutate({
      version: versionInput.trim() === "" ? null : versionInput.trim(),
      locked: lockedInput,
    });
  }

  const status = $derived.by(() => {
    if ($stateM.isPending || $settingsM.isPending || $versionM.isPending) return "saving" as const;
    if ($stateM.isError || $settingsM.isError || $versionM.isError) return "error" as const;
    if ($stateM.isSuccess || $settingsM.isSuccess || $versionM.isSuccess) return "saved" as const;
    return "idle" as const;
  });

  const errorMsg = $derived(
    $stateM.error?.message ?? $settingsM.error?.message ?? $versionM.error?.message ?? null,
  );
</script>

<SectionCard
  id="claude-engine"
  title="Claude engine"
  description="Claude API state, default model, max tokens, and fleet wrapper version."
  {status}
  savedAt={lastSavedAt}
  error={errorMsg}
>
  <SwitchRow
    id="claude-state-toggle"
    label="Disable Claude engine"
    description={$stateQ.isPending
      ? "Loading…"
      : $stateQ.data?.disabled
        ? "Claude routes are disabled."
        : "Claude routes are enabled."}
    checked={$stateQ.data?.disabled ?? false}
    disabled={$stateQ.isPending || $stateM.isPending}
    onCheckedChange={(v) => $stateM.mutate(v)}
  />

  <Separator />

  <div class="grid gap-3">
    <p class="text-sm font-medium">Claude model defaults</p>
    <div class="grid gap-3 sm:grid-cols-2">
      <div class="grid gap-1.5">
        <Label for="claude-model">Default model</Label>
        <Input id="claude-model" bind:value={modelInput} placeholder="claude-sonnet-4-6" />
      </div>
      <div class="grid gap-1.5">
        <Label for="claude-max-tokens">Max tokens</Label>
        <Input id="claude-max-tokens" type="number" min={256} max={200000} bind:value={maxTokensInput} />
      </div>
    </div>
    <div>
      <Button size="sm" disabled={$settingsM.isPending} onclick={saveSettings}>Save model defaults</Button>
    </div>
  </div>

  <Separator />

  <div class="grid gap-3">
    <p class="text-sm font-medium">Claude wrapper version</p>
    <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
      <div class="grid gap-1.5">
        <Label for="claude-version">Version</Label>
        <Input id="claude-version" bind:value={versionInput} placeholder="e.g. 0.2.4 or empty for latest" />
      </div>
      <div class="flex items-end gap-2 pb-0.5">
        <SwitchRow
          id="claude-version-locked"
          label="Lock"
          description="Pin fleet to this exact version"
          checked={lockedInput}
          onCheckedChange={(v) => (lockedInput = v)}
        />
      </div>
    </div>
    <div>
      <Button size="sm" disabled={$versionM.isPending} onclick={saveVersion}>Save Claude version</Button>
    </div>
    {#if $versionQ.data?.updated_at}
      <p class="text-xs text-muted-foreground">
        Last set at <span class="tabular-nums">{$versionQ.data.updated_at}</span>
      </p>
    {/if}
  </div>
</SectionCard>
