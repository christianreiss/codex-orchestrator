<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Separator } from "$lib/components/ui/separator";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import { CLAUDE_MODEL_OPTIONS } from "$lib/constants/models";
  import {
    claudeSettingsMutation,
    claudeSettingsQuery,
    claudeStateMutation,
    claudeStateQuery,
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

  const status = $derived.by(() => {
    if ($stateM.isPending || $settingsM.isPending) return "saving" as const;
    if ($stateM.isError || $settingsM.isError) return "error" as const;
    if ($stateM.isSuccess || $settingsM.isSuccess) return "saved" as const;
    return "idle" as const;
  });

  const errorMsg = $derived(
    $stateM.error?.message ?? $settingsM.error?.message ?? null,
  );
</script>

<SectionCard
  id="claude-engine"
  title="Claude engine"
  description="Claude API state, default model, and max tokens."
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
        <ModelSelect
          id="claude-model"
          allowCustom
          bind:value={modelInput}
          options={CLAUDE_MODEL_OPTIONS}
          label="Default model"
          placeholder="claude-sonnet-4-6"
          class="w-full"
        />
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
</SectionCard>
