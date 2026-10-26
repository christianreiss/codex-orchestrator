<script lang="ts">
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { modelPolicyQuery } from '$lib/api/model-policy';
  import { filterModelOptions } from '$lib/components/ui/model-select/policy';
  import { derived } from "svelte/store";
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { authStore } from "$lib/stores/auth";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { CODEX_MODELS, REASONING_EFFORT_OPTIONS } from "$lib/constants/models";
  import { nativeSettingsApi, nativeSettingsKeys, type EngineConfig } from "$lib/api/nativeSettings";
  import { claudeSettingsKeys } from "$lib/api/claudeSettings";
  import { mergeNativeSettings, nativeSettingsOf, parseNativeSettings, sameSettings, editableProfilesOf, parseNativeProfiles, mergeNativeProfiles } from "./config-edit";

  let { engine, profiles = false }: { engine: Engine; profiles?: boolean } = $props();
  const policy = modelPolicyQuery(untrack(() => engine));
  const currentModels = $derived(filterModelOptions(CODEX_MODELS, $policy.data));
  const sectionId = $derived(`${engine}-${profiles ? "profile" : "native"}-settings`);
  const settingsLabel = $derived(profiles ? "profiles" : "native settings");
  const readSettings = (settings: EngineConfig["settings"]) => profiles ? editableProfilesOf(settings)
    : settings && Object.hasOwn(settings, "native_settings") ? settings.native_settings : nativeSettingsOf(settings);
  const parse = (text: string) => profiles ? parseNativeProfiles(text) : parseNativeSettings(text);
  const references = {
    codex: { version: "0.164.0", url: "https://developers.openai.com/codex/config-reference/" },
    claude: { version: "2.1.310", url: "https://code.claude.com/docs/en/settings-reference" },
    grok: { version: "1.0.70", url: "https://docs.x.ai/build/settings/reference" },
  };
  const qc = useQueryClient();
  const query = createQuery<EngineConfig>(derived(authStore, auth => ({
    queryKey: nativeSettingsKeys.config(engine),
    queryFn: () => nativeSettingsApi.get(engine),
    enabled: auth.can("content.read"),
  })));
  let baseline = $state<EngineConfig | null>(null);
  let draft = $state("{}");
  let preview = $state<string | null>(null);
  let previewDraft = $state("");
  let error = $state<string | null>(null);
  let saved = $state(false);
  const canRead = $derived($authStore.can("content.read"));
  const canManage = $derived($authStore.can("content.manage"));
  const parsed = $derived.by(() => {
    try { return { value: parse(draft), error: null }; }
    catch (e) { return { value: null, error: e instanceof Error ? e.message : "Invalid JSON" }; }
  });
  const dirty = $derived(baseline !== null && (parsed.error
    ? draft !== JSON.stringify(readSettings(baseline.settings), null, 2)
    : !sameSettings(parsed.value, readSettings(baseline.settings))));
  const conflict = $derived(baseline !== null && $query.data !== undefined
    && !sameSettings(readSettings(baseline.settings), readSettings($query.data.settings)) && dirty);

  function load(data: EngineConfig) {
    baseline = data;
    draft = JSON.stringify(readSettings(data.settings), null, 2);
    preview = null;
    error = null;
    saved = false;
  }
  $effect(() => {
    const data = $query.data;
    if (data && untrack(() => !baseline || !dirty)) untrack(() => load(data));
  });
  const mutation = createMutation({
    mutationFn: async (save: boolean) => {
      const submitted = draft;
      const value = parse(submitted);
      if (!baseline) throw new Error("Load the saved settings before continuing.");
      const latest = await nativeSettingsApi.get(engine);
      qc.setQueryData(nativeSettingsKeys.config(engine), latest);
      const settings = profiles
        ? mergeNativeProfiles(baseline.settings ?? {}, latest.settings ?? {}, value as ReturnType<typeof parseNativeProfiles>)
        : mergeNativeSettings(baseline.settings ?? {}, latest.settings ?? {}, value as ReturnType<typeof parseNativeSettings>);
      const rendered = await nativeSettingsApi.render(engine, settings);
      if (!save) return { submitted, rendered, stored: null };
      const stored = await nativeSettingsApi.store(engine, settings, latest.sha256 ?? null, latest.revision);
      return { submitted, rendered, stored };
    },
    onSuccess: ({ submitted, rendered, stored }) => {
      if (stored) {
        baseline = stored;
        draft = JSON.stringify(readSettings(stored.settings), null, 2);
        qc.setQueryData(nativeSettingsKeys.config(engine), stored);
        void qc.invalidateQueries({ queryKey: ["settings"] });
        if (engine === "claude") void qc.invalidateQueries({ queryKey: claudeSettingsKeys.config() });
        toast.success(stored.change === "unchanged" ? "No changes to save" : "Native settings saved");
      }
      preview = profiles
        ? (rendered.profiles ?? []).map(p => `# ${p.name}.config.toml\n${p.content}`).join("\n") || "No profile sidecars"
        : (stored ?? rendered).content;
      previewDraft = stored ? draft : submitted;
      error = null;
      saved = stored !== null;
    },
    onError: (e) => { error = e instanceof Error ? e.message : "Could not validate or save settings"; },
  });
  async function reload() {
    const result = await $query.refetch();
    if (result.data && !result.error) load(result.data);
  }
</script>
<DraftGuard {dirty} />

<section id={sectionId} class="border-t py-5" aria-labelledby={`${sectionId}-heading`}>
  <h3 id={`${sectionId}-heading`} class="text-body-sm font-semibold">{ENGINE_META[engine].label} {settingsLabel}</h3>
  <p class="mt-1 max-w-3xl text-body-sm text-muted-foreground">
    {#if profiles}
      Create or remove named profiles with a JSON array. Each entry accepts name, model, model_reasoning_effort and native_settings.
      Omit model and effort (or use null) to inherit. Removing an entry removes its managed profile sidecar on the next sync.
    {:else}
      Add native user settings as a JSON object. System and enterprise policy files have separate scopes.
    Validation rejects deprecated or unsupported values.
    Model and effort use the controls above; existing fleet controls take precedence for settings they own.
    {/if}
  </p>
  {#if engine === "claude" && !profiles}
    <p class="mt-2 max-w-3xl text-body-sm text-muted-foreground">
      sandbox.allowNestedUserNamespaces requires Claude Code 2.1.305 or newer. It defaults to false.
      Setting it to true lets sandboxed commands escape the sandbox; protected paths and credentials are no longer a security boundary.
      Desktop-only sshHostCommands is configured in Claude Desktop.
    </p>
  {/if}
  <p class="mt-1 text-caption text-muted-foreground">
    Reference: <a class="underline underline-offset-2" href={references[engine].url} target="_blank" rel="noreferrer">{ENGINE_META[engine].label} {references[engine].version} settings</a>
  </p>
  {#if profiles}
    <details class="mt-2 text-caption text-muted-foreground">
      <summary class="cursor-pointer">Profile example and current choices</summary>
      <pre class="mt-2 overflow-auto">{JSON.stringify([{ name: "review", model: "gpt-6.1-sol", model_reasoning_effort: "high", native_settings: { service_tier: "priority" } }], null, 2)}</pre>
      <p class="mt-2">Models: {currentModels.map(m => m.value).join(", ")}</p>
      <p>Effort: {REASONING_EFFORT_OPTIONS.map(e => e.value).join(", ")}. Availability depends on the model.</p>
    </details>
  {/if}
  {#if !canRead}
    <p class="mt-3 text-body-sm text-muted-foreground">Your role needs content.read to view native settings.</p>
  {:else if $query.isPending}
    <p class="mt-3 text-body-sm text-muted-foreground">Loading native settings…</p>
  {:else}
    {#if $query.isError}
      <p role="alert" class="mt-3 text-body-sm text-destructive">Could not load settings: {$query.error.message}</p>
    {/if}
    {#if baseline}
      <div class="mt-3 space-y-2">
        <label for={`${sectionId}-json`} class="block text-caption font-medium">{ENGINE_META[engine].label} {settingsLabel} JSON</label>
        <textarea id={`${sectionId}-json`} class="min-h-48 w-full rounded-md border bg-background p-3 font-mono text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          bind:value={draft} spellcheck={false} readonly={!canManage} disabled={$mutation.isPending}
          aria-invalid={Boolean(parsed.error || error || (!dirty && baseline.validation_error))} aria-describedby={`${sectionId}-feedback`}
          oninput={() => { error = null; saved = false; }}></textarea>
        <div id={`${sectionId}-feedback`} class="text-body-sm" aria-live="polite">
          {#if baseline.validation_error}
            <p class="text-destructive">Saved configuration is invalid: {baseline.validation_error.message} Correct the saved values, then validate and save. Your draft is retained.</p>
          {/if}
          {#if parsed.error}<p class="text-destructive">{parsed.error}</p>{/if}
          {#if error}<p role="alert" class="text-destructive">{error}</p>{/if}
          {#if conflict}<p class="text-warning-muted-foreground">Native settings changed elsewhere. Your draft is kept; copy it before loading the saved settings.</p>{/if}
          {#if !error && !parsed.error && !conflict && !baseline.validation_error}
            <p class="text-muted-foreground">{dirty ? "Unsaved changes" : saved ? "Saved" : baseline.status === "missing" ? "No fleet configuration saved yet" : "Saved settings loaded"}</p>
          {/if}
        </div>
      </div>
    {/if}
    <div class="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onclick={() => $mutation.mutate(false)} disabled={!baseline || Boolean(parsed.error) || conflict || $mutation.isPending || $query.isError}>Validate and preview</Button>
      <Button size="sm" onclick={() => $mutation.mutate(true)} disabled={!canManage || !dirty || Boolean(parsed.error) || conflict || $mutation.isPending || $query.isError}>Save {settingsLabel}</Button>
      <Button variant="outline" size="sm" onclick={() => void reload()} disabled={$query.isFetching || $mutation.isPending}>{dirty ? "Discard draft and reload" : `Reload ${settingsLabel}`}</Button>
    </div>
    {#if !canManage}<p class="mt-2 text-caption text-muted-foreground">Read-only: saving requires content.manage.</p>{/if}
    {#if preview !== null && previewDraft === draft}
      <details open class="mt-4 min-w-0">
        <summary class="cursor-pointer text-body-sm font-medium">Validated configuration preview</summary>
        <pre class="mt-2 max-h-96 overflow-auto rounded-md border bg-muted p-3 text-caption">{preview}</pre>
      </details>
    {/if}
  {/if}
</section>
