<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import { GROK_MODEL_OPTIONS } from "$lib/constants/models";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { grokStateQuery, grokStateMutation, grokSettingsQuery, grokSettingsMutation } from "$lib/api/settings";
  const serviceState = grokStateQuery();
  const settings = grokSettingsQuery();
  const toggle = grokStateMutation({ onError: (error) => toast.error(error.message) });
  const save = grokSettingsMutation({ onSuccess: () => toast.success("Grok gateway defaults saved"), onError: (error) => toast.error(error.message) });
  let model = $state("");
  let initialized = false;
  $effect(() => { if (!initialized && $settings.data) { model = $settings.data.default_model; initialized = true; } });
</script>
<SectionCard id="grok-engine" title="Grok API gateway" description="Text inference through verified Grok subscription accounts. Gateway defaults are separate from managed Grok Build settings." error={$serviceState.error?.message ?? $settings.error?.message ?? $toggle.error?.message ?? $save.error?.message}>
  <SwitchRow id="grok-state-toggle" label="Disable Grok API gateway" description={$serviceState.isPending ? "Loading…" : $serviceState.data?.disabled ? "Grok gateway routes are disabled." : "Grok gateway routes are enabled."} checked={$serviceState.data?.disabled ?? false} disabled={$serviceState.isPending || $toggle.isPending} onCheckedChange={(value) => $toggle.mutate(value)} />
  <div class="grid gap-2 border-t pt-4">
    <Label for="grok-proxy-model">Gateway default model</Label>
    <ModelSelect id="grok-proxy-model" bind:value={model} options={GROK_MODEL_OPTIONS} label="Gateway default model" placeholder="grok-4.6" />
    <p class="text-xs text-muted-foreground">Supports text messages and system instructions. Streaming, tools, images, sampling controls, and token limits are unavailable.</p>
    <div><Button size="sm" disabled={$save.isPending || $settings.isPending || !model} onclick={() => $save.mutate({ default_model: model })}>Save gateway default</Button></div>
  </div>
</SectionCard>
