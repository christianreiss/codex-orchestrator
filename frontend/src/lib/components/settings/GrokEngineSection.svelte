<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { ModelSelect } from "$lib/components/ui/model-select";
  import { GROK_MODEL_OPTIONS } from "$lib/constants/models";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { grokSettingsQuery, grokSettingsMutation, grokModelsQuery, grokModelToggleMutation } from "$lib/api/settings";
  const settings = grokSettingsQuery();
  const save = grokSettingsMutation({ onSuccess: () => toast.success("Grok gateway defaults saved"), onError: (error) => toast.error(error.message) });
  let model = $state("");
  let initialized = false;
  $effect(() => { if (!initialized && $settings.data) { model = $settings.data.default_model; initialized = true; } });
  const models = grokModelsQuery();
  const modelLabel = (id: string) => GROK_MODEL_OPTIONS.find((option) => option.value === id)?.label ?? id;
  const modelToggle = grokModelToggleMutation({ onSuccess: (result) => toast.success(`${modelLabel(result.model)} ${result.enabled ? "enabled" : "disabled"}`), onError: (error) => toast.error(error.message) });
  const catalog = $derived($models.data?.models ?? []);
  // Until the catalog loads, offer every known model rather than an empty picker.
  const enabledOptions = $derived(catalog.length ? catalog.filter((entry) => entry.enabled).map((entry) => ({ label: modelLabel(entry.id), value: entry.id })) : GROK_MODEL_OPTIONS);
  const modelDisabled = $derived(catalog.some((entry) => entry.id === model && !entry.enabled));
</script>
<SectionCard id="grok-engine" title="Grok API gateway" description="Text inference through verified Grok subscription accounts, for every exposed API routed to Grok. Gateway defaults are separate from managed Grok Build settings." error={$settings.error?.message ?? $models.error?.message ?? $save.error?.message ?? $modelToggle.error?.message}>
  <div class="grid gap-2">
    <Label for="grok-proxy-model">Gateway default model</Label>
    <ModelSelect id="grok-proxy-model" bind:value={model} options={enabledOptions} label="Gateway default model" placeholder="grok-4.7" />
    {#if modelDisabled}<p class="text-xs text-destructive">{modelLabel(model)} is disabled; requests without a model fail until the default is an enabled model.</p>{/if}
    <p class="text-xs text-muted-foreground">Supports text messages and system instructions. Streaming, tools, images, sampling controls, and token limits are unavailable.</p>
    <div><Button size="sm" disabled={$save.isPending || $settings.isPending || !model || modelDisabled} onclick={() => $save.mutate({ default_model: model })}>Save gateway default</Button></div>
  </div>
  <div class="grid gap-2 border-t pt-4">
    <p class="text-sm font-medium">Gateway models</p>
    <p class="text-xs text-muted-foreground">Disabled models leave the model list of every API routed to Grok and are rejected at inference. Managed Grok Build hosts are unaffected.</p>
    {#if $models.isPending}
      <p class="text-xs text-muted-foreground">Loading…</p>
    {:else}
      {#each catalog as entry (entry.id)}
        <SwitchRow id={`grok-model-${entry.id}`} label={modelLabel(entry.id)} description={entry.enabled ? `${entry.id} is offered by the gateway.` : `${entry.id} is disabled.`} checked={entry.enabled} disabled={$modelToggle.isPending} onCheckedChange={(enabled) => $modelToggle.mutate({ model: entry.id, enabled })} />
      {/each}
    {/if}
  </div>
</SectionCard>
