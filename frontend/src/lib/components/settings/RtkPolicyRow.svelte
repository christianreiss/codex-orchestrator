<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { rtkReadiness, type RtkEngine, type RtkPolicy } from "$lib/api/rtk";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import * as Select from "$lib/components/ui/select";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import HostOverrideBadge from "$lib/components/policies/HostOverrideBadge.svelte";
  let { engine, policy, hostId, canManage, stale = false, overrideCount }: { engine: RtkEngine; policy: RtkPolicy; hostId?: string; canManage: boolean; stale?: boolean; overrideCount?: number | null } = $props();
  const qc = useQueryClient();
  const uid = $props.id();
  let attempted = $state<boolean | null | undefined>(undefined);
  let reconciling = $state(false);
  const endpoint = $derived(hostId ? `/admin/hosts/${hostId}/rtk` : "/admin/rtk");
  const selected = $derived(policy.override === null ? "inherit" : policy.override ? "enabled" : "disabled");
  const labels: Record<string, string> = { inherit: "Inherit", enabled: "Enabled", disabled: "Disabled" };
  const save = createMutation({
    mutationFn: (enabled: boolean | null) => api.post<RtkPolicy>(`${endpoint}/${engine}`, { enabled }),
    onSettled: async () => {
      reconciling = true;
      try { await Promise.all([qc.invalidateQueries({ queryKey: ["settings", "rtk"] }), qc.invalidateQueries({ queryKey: ["hosts"] })]); }
      finally { reconciling = false; }
    },
  });
  const describedBy = $derived([`${uid}-policy`, policy.adapter_mode ? `${uid}-mode` : null, hostId ? `${uid}-report` : null, hostId && policy.observation?.error_code ? `${uid}-runtime-error` : null, $save.error ? `${uid}-error` : null].filter(Boolean).join(" "));
  let now = $state(Date.now());
  $effect(() => {
    if (!hostId) return;
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });
  async function change(value: boolean | null) {
    attempted = value;
    try { await $save.mutateAsync(value); } catch { /* Keep the attempted value and inline error. */ }
  }
  const disabled = $derived(!canManage || stale || $save.isPending || reconciling || policy.assigned === false);
</script>
<div class="space-y-2 py-3" data-testid={`rtk-${engine}`}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <h3 class="text-body font-semibold capitalize">{engine}</h3>
        {#if !hostId}<HostOverrideBadge count={overrideCount} noun="output-filtering rule" />{/if}
      </div>
      <p id={`${uid}-policy`} class="text-body-sm text-muted-foreground">{policy.enabled ? "Enabled" : "Disabled"}{hostId ? ` · ${policy.source === "host" ? "Host override" : "Fleet default"}` : " for new managed sessions"}</p>
    </div>
    {#if hostId}
      <div class="w-40">
        <Select.Root type="single" value={selected} onValueChange={(v) => { if (v) void change(v === "inherit" ? null : v === "enabled"); }} {disabled}>
          <Select.Trigger aria-describedby={describedBy} aria-label={`${engine} output filtering`}><span>{labels[selected]}</span></Select.Trigger>
          <Select.Content><Select.Item value="inherit" label="Inherit">Inherit</Select.Item><Select.Item value="enabled" label="Enabled">Enabled</Select.Item><Select.Item value="disabled" label="Disabled">Disabled</Select.Item></Select.Content>
        </Select.Root>
      </div>
    {:else}
      <Switch checked={policy.enabled} onCheckedChange={(v) => void change(v)} {disabled} aria-describedby={describedBy} aria-label={`${engine} output filtering`} />
    {/if}
  </div>
  {#if policy.adapter_mode === "instructions"}<p id={`${uid}-mode`} class="text-body-sm text-muted-foreground">Instruction mode: the agent chooses when to use RTK. Commands are not rewritten automatically.</p>{:else if policy.adapter_mode === "hook"}<p id={`${uid}-mode`} class="text-body-sm text-muted-foreground">Hook mode: supported commands can be rewritten before execution.</p>{/if}
  {#if hostId}
    <p id={`${uid}-report`} class="text-body-sm text-muted-foreground">{rtkReadiness(policy, now)}{#if policy.observation} · Reported <Timestamp value={policy.observation.observed_at} />{/if}</p>
    {#if policy.observation}
      <p class="break-words text-caption text-muted-foreground">RTK {policy.observation.rtk_version || "version unavailable"} · cxx {policy.observation.wrapper_version} · Native {policy.observation.native_version || "version unavailable"}</p>
      {#if policy.observation.error_code}<p id={`${uid}-runtime-error`} class="break-words text-body-sm text-destructive">{policy.observation.error_code}. Run <code>cxx sync</code>, then <code>cxx rtk status</code> on this host.</p>{/if}
    {:else if policy.enabled && policy.assigned !== false}<p class="text-body-sm text-muted-foreground">Run <code>cxx sync</code>, then start a new session on this host.</p>{/if}
  {/if}
  <div aria-live="polite" class="text-body-sm">
    {#if $save.isPending || reconciling}<p role="status">{$save.isPending ? "Saving…" : "Refreshing confirmed policy…"}</p>
    {:else if $save.error}
      <p id={`${uid}-error`} role="alert" class="text-destructive">Save unconfirmed: {$save.error.message}. Requested: {attempted === null ? "Inherit" : attempted ? "Enabled" : "Disabled"}. The policy above shows the last fetched state.</p>
      <Button variant="outline" size="sm" disabled={disabled} onclick={() => { if (attempted !== undefined) void change(attempted); }}>Retry change</Button>
    {:else if $save.isSuccess}<p role="status" class="text-muted-foreground">Saved. Applies to new sessions after host sync.</p>{/if}
  </div>
</div>
