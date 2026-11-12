<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { authStore } from "$lib/stores/auth";
  import { Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  type Policy = { enabled: boolean; override: boolean | null; global: boolean; supported: boolean; activation: string | null; control: string };
  type Policies = { engines: Record<string, Policy> };
  const engines = ["codex", "claude", "grok", "kimi"];
  const qc = useQueryClient();
  const query = createQuery({ queryKey: ["settings", "speech-input"], queryFn: () => api.get<Policies>("/admin/speech-input") });
  const save = createMutation({ mutationFn: ({ target, enabled }: { target: string; enabled: boolean | null }) => api.post<Policies>(`/admin/speech-input/${target}`, { enabled }), onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "speech-input"] }) });
  const disabled = $derived(!$authStore.can("settings.manage") || $save.isPending || $query.isError);
  async function change(target: string, value: string) { try { await $save.mutateAsync({ target, enabled: value === "inherit" ? null : value === "on" }); } catch { /* Inline error retains the current policy. */ } }
</script>
<Section id="speech-input" title="Speech input" description="Native CLI speech features. Defaults apply after host sync to new launches; enabling does not start recording.">
  {#if $query.isPending}<p role="status">Loading speech input…</p>{/if}
  {#if $query.error}<p role="alert">Could not load speech input: {$query.error.message}</p><Button variant="outline" onclick={() => void $query.refetch()}>Retry</Button>{/if}
  {#if $save.error}<p role="alert">Could not save speech input: {$save.error.message}</p>{/if}
  {#if $query.data}
    <div class="divide-y border-y">
      {#each ["global", ...engines] as target}
        {@const policy = $query.data.engines[target === "global" ? "codex" : target]}
        {@const value = target === "global" ? (policy.global ? "on" : "off") : policy.override === null ? "inherit" : policy.override ? "on" : "off"}
        <div class="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><h3 id={`speech-${target}`} class="text-body font-semibold capitalize">{target === "global" ? "Global default" : target}</h3>
            {#if target !== "global"}<p class="text-body-sm text-muted-foreground">Requested: {policy.enabled ? "On" : "Off"}. {target === "kimi" ? "Native speech input is not supported." : target === "codex" ? "Voice conversation via /voice; central enable/disable is unavailable in this CLI version." : target === "grok" ? "Controls the dictation shortcut; /voice remains available when off." : "Dictation via /voice hold. Requires a Claude.ai account and local microphone."}</p>{/if}
          </div>
          <Select.Root type="single" {value} {disabled} onValueChange={(v) => { if (v) void change(target, v); }}>
            <Select.Trigger class="w-40" aria-labelledby={`speech-${target}`}>{value === "inherit" ? "Inherit" : value === "on" ? "On" : "Off"}</Select.Trigger>
            <Select.Content>{#if target !== "global"}<Select.Item value="inherit">Inherit</Select.Item>{/if}<Select.Item value="on">On</Select.Item><Select.Item value="off">Off</Select.Item></Select.Content>
          </Select.Root>
        </div>
      {/each}
    </div>
  {/if}
</Section>
