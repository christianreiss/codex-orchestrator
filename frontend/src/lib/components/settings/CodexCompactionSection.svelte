<script lang="ts">
  import { derived } from "svelte/store";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { authStore } from "$lib/stores/auth";
  import { nativeSettingsApi, nativeSettingsKeys, type EngineConfig } from "$lib/api/nativeSettings";
  import SettingRow from "./SettingRow.svelte";
  import { codexAsyncCompactionEnabled, setCodexAsyncCompaction } from "./codex-compaction";

  const qc = useQueryClient();
  const query = createQuery<EngineConfig>(derived(authStore, auth => ({
    queryKey: nativeSettingsKeys.config("codex"), queryFn: () => nativeSettingsApi.get("codex"),
    enabled: auth.can("content.read"),
  })));
  const mutation = createMutation({
    mutationFn: async (enabled: boolean) => {
      if (!$query.data) throw new Error("Load Codex settings before changing compaction.");
      const latest = await nativeSettingsApi.get("codex");
      qc.setQueryData(nativeSettingsKeys.config("codex"), latest);
      const settings = setCodexAsyncCompaction(latest.settings ?? {}, enabled);
      const rendered = await nativeSettingsApi.render("codex", settings);
      return nativeSettingsApi.store("codex", rendered.settings, latest.sha256 ?? null, latest.revision);
    },
    onSuccess: stored => {
      qc.setQueryData(nativeSettingsKeys.config("codex"), stored);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  let checked = $state(false);
  $effect(() => {
    const current = codexAsyncCompactionEnabled($query.data?.settings ?? {});
    if (!$mutation.isPending) checked = current;
  });
  async function save(enabled: boolean) {
    checked = enabled;
    try { await $mutation.mutateAsync(enabled); }
    finally { checked = codexAsyncCompactionEnabled($query.data?.settings ?? {}); }
  }
</script>

<SettingRow id="codex-async-compaction" bordered={false}
  label="Async compaction"
  description={$query.isError ? "Could not load Codex settings. Reload the page to retry." : "Experimental: prepares conversation compaction in the background. Codex 0.163.0 still marks it under development and off by default, so the fleet leaves it off unless enabled here (requires Codex 0.163.0+). Changes save immediately and apply on the next config sync."}
  {checked}
  disabled={!$authStore.can("content.manage") || !$query.data || $query.isError || $mutation.isPending}
  onCheckedChange={save}
/>
