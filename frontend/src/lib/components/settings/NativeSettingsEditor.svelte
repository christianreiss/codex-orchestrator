<script lang="ts">
  import { derived } from "svelte/store";
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { authStore } from "$lib/stores/auth";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { nativeSettingsApi, nativeSettingsKeys, type EngineConfig } from "$lib/api/nativeSettings";
  import { claudeSettingsKeys } from "$lib/api/claudeSettings";
  import { mergeNativeSettings, nativeSettingsOf, parseNativeSettings, sameSettings } from "./config-edit";

  let { engine }: { engine: Engine } = $props();
  const references = {
    codex: { version: "0.162.1", url: "https://developers.openai.com/codex/config-reference/" },
    claude: { version: "2.1.296", url: "https://code.claude.com/docs/en/settings-reference" },
    grok: { version: "1.0.50", url: "https://docs.x.ai/build/settings/reference" },
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
    try { return { value: parseNativeSettings(draft), error: null }; }
    catch (e) { return { value: null, error: e instanceof Error ? e.message : "Invalid JSON" }; }
  });
  const dirty = $derived(baseline !== null && !sameSettings(parsed.value, nativeSettingsOf(baseline.settings)));
  const conflict = $derived(baseline !== null && $query.data !== undefined
    && !sameSettings(nativeSettingsOf(baseline.settings), nativeSettingsOf($query.data.settings)) && dirty);

  function load(data: EngineConfig) {
    baseline = data;
    draft = JSON.stringify(nativeSettingsOf(data.settings), null, 2);
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
      const value = parseNativeSettings(submitted);
      if (!baseline) throw new Error("Load the saved settings before continuing.");
      const latest = await nativeSettingsApi.get(engine);
      qc.setQueryData(nativeSettingsKeys.config(engine), latest);
      const settings = mergeNativeSettings(baseline.settings ?? {}, latest.settings ?? {}, value);
      const rendered = await nativeSettingsApi.render(engine, settings);
      if (!save) return { submitted, rendered, stored: null };
      const stored = await nativeSettingsApi.store(engine, settings, latest.sha256 ?? null, latest.revision);
      return { submitted, rendered, stored };
    },
    onSuccess: ({ submitted, rendered, stored }) => {
      if (stored) {
        baseline = stored;
        draft = JSON.stringify(nativeSettingsOf(stored.settings), null, 2);
        qc.setQueryData(nativeSettingsKeys.config(engine), stored);
        void qc.invalidateQueries({ queryKey: ["settings"] });
        if (engine === "claude") void qc.invalidateQueries({ queryKey: claudeSettingsKeys.config() });
        toast.success(stored.change === "unchanged" ? "No changes to save" : "Native settings saved");
      }
      preview = (stored ?? rendered).content;
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

<section id={`${engine}-native-settings`} class="border-t py-5" aria-labelledby={`${engine}-native-heading`}>
  <h3 id={`${engine}-native-heading`} class="text-sm font-semibold">{ENGINE_META[engine].label} native settings</h3>
  <p class="mt-1 max-w-3xl text-sm text-muted-foreground">
    Add native user settings as a JSON object. System and enterprise policy files have separate scopes.
    Validation rejects deprecated or unsupported values.
    Model and effort use the controls above; existing fleet controls take precedence for settings they own.
  </p>
  <p class="mt-1 text-xs text-muted-foreground">
    Reference: <a class="underline underline-offset-2" href={references[engine].url} target="_blank" rel="noreferrer">{ENGINE_META[engine].label} {references[engine].version} settings</a>
  </p>
  {#if !canRead}
    <p class="mt-3 text-sm text-muted-foreground">Your role needs content.read to view native settings.</p>
  {:else if $query.isPending}
    <p class="mt-3 text-sm text-muted-foreground">Loading native settings…</p>
  {:else}
    {#if $query.isError}
      <p role="alert" class="mt-3 text-sm text-destructive">Could not load settings: {$query.error.message}</p>
    {/if}
    {#if baseline}
      <div class="mt-3 space-y-2">
        <label for={`${engine}-native-json`} class="block text-xs font-medium">{ENGINE_META[engine].label} native settings JSON</label>
        <textarea id={`${engine}-native-json`} class="min-h-48 w-full rounded-md border bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          bind:value={draft} spellcheck={false} readonly={!canManage} disabled={$mutation.isPending}
          aria-invalid={Boolean(parsed.error)} aria-describedby={`${engine}-native-feedback`}
          oninput={() => { error = null; saved = false; }}></textarea>
        <div id={`${engine}-native-feedback`} class="text-sm" aria-live="polite">
          {#if parsed.error}<p class="text-destructive">{parsed.error}</p>{/if}
          {#if error}<p role="alert" class="text-destructive">{error}</p>{/if}
          {#if conflict}<p class="text-warning-muted-foreground">Native settings changed elsewhere. Your draft is kept; copy it before loading the saved settings.</p>{/if}
          {#if !error && !parsed.error && !conflict}
            <p class="text-muted-foreground">{dirty ? "Unsaved changes" : saved ? "Saved" : baseline.status === "missing" ? "No fleet configuration saved yet" : "Saved settings loaded"}</p>
          {/if}
        </div>
      </div>
    {/if}
    <div class="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onclick={() => $mutation.mutate(false)} disabled={!baseline || Boolean(parsed.error) || conflict || $mutation.isPending || $query.isError}>Validate and preview</Button>
      <Button size="sm" onclick={() => $mutation.mutate(true)} disabled={!canManage || !dirty || Boolean(parsed.error) || conflict || $mutation.isPending || $query.isError}>Save native settings</Button>
      <Button variant="outline" size="sm" onclick={() => void reload()} disabled={$query.isFetching || $mutation.isPending}>{dirty ? "Discard draft and reload" : "Reload native settings"}</Button>
    </div>
    {#if !canManage}<p class="mt-2 text-xs text-muted-foreground">Read-only: saving requires content.manage.</p>{/if}
    {#if preview !== null && previewDraft === draft}
      <details open class="mt-4 min-w-0">
        <summary class="cursor-pointer text-sm font-medium">Validated configuration preview</summary>
        <pre class="mt-2 max-h-96 overflow-auto rounded-md border bg-muted p-3 text-xs">{preview}</pre>
      </details>
    {/if}
  {/if}
</section>
