<script lang="ts">
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Switch } from "$lib/components/ui/switch";
  import PolicyCard from "./PolicyCard.svelte";

  type Values = { enabled?: boolean; inactivity_window_days?: number; days_logs?: number; days_mcp?: number; days_events?: number; days_graph_stats?: number };
  type Field = { key: Exclude<keyof Values, "enabled">; label: string };
  let { kind }: { kind: "prune-policy" | "log-retention" } = $props();
  const policyKind = untrack(() => kind);
  const retention = policyKind === "log-retention";
  const fields: Field[] = retention ? [
    { key: "days_logs", label: "API logs" }, { key: "days_mcp", label: "MCP logs" },
    { key: "days_events", label: "Events" }, { key: "days_graph_stats", label: "Graph statistics" },
  ] : [{ key: "inactivity_window_days", label: "Inactivity window" }];
  const qc = useQueryClient();
  // Retention shares its existing query shape; pruning reads overview because
  // there is no dedicated GET. Both participate in settings.changed fanout.
  const queryKey = ["settings", policyKind];
  const query = createQuery<Values>({ queryKey, queryFn: async () => {
    if (retention) return api.get<Values>("/admin/log-retention");
    const overview = await api.get<Values>("/admin/overview");
    return { inactivity_window_days: overview.inactivity_window_days };
  } });
  let draft = $state<Record<string, number | undefined>>({});
  let baseline = $state<string | null>(null);
  const extract = (data: Values) => Object.fromEntries(fields.map((field) => [field.key, data[field.key]]));
  const signature = (data: Values) => JSON.stringify(extract(data));
  const dirty = $derived(baseline !== null && JSON.stringify(draft) !== baseline);
  const conflict = $derived(dirty && !!$query.data && signature($query.data) !== baseline);
  const errors = $derived(Object.fromEntries(fields.map(({ key }) => [key,
    !Number.isInteger(draft[key]) || Number(draft[key]) < (retention ? 1 : 0) || Number(draft[key]) > (retention ? 365 : 60)
      ? `Enter a whole number from ${retention ? "1 to 365" : "0 to 60"}.` : ""
  ])));
  const valid = $derived(Object.values(errors).every((error) => !error));
  function adopt(data: Values) { draft = extract(data); baseline = signature(data); }
  $effect(() => {
    const data = $query.data;
    if (data) untrack(() => { if (baseline === null || !dirty) adopt(data); });
  });
  function accept(data: Values) {
    qc.setQueryData(queryKey, data);
    void qc.invalidateQueries({ queryKey: ["overview"] });
  }
  const saveMutation = createMutation<Values, Error, Values>({
    mutationFn: (value) => api.post<Values>(`/admin/${policyKind}`, retention ? value : { inactivity_days: value.inactivity_window_days }),
    onSuccess: (data) => { adopt(data); accept(data); },
    onSettled: () => { void qc.invalidateQueries({ queryKey }); },
  });
  const toggleMutation = createMutation<Values, Error, boolean>({
    // Submit saved durations, never the unsaved numeric draft.
    mutationFn: (enabled) => api.post<Values>("/admin/log-retention", { ...$query.data, enabled }),
    onSuccess: accept,
    onSettled: () => { void qc.invalidateQueries({ queryKey }); },
  });
  const busy = $derived($saveMutation.isPending || $toggleMutation.isPending);
  const disabled = $derived(!$authStore.can("settings.manage") || !$query.isSuccess || $query.isFetching || busy);
  function reset() { if ($query.data) adopt($query.data); $saveMutation.reset(); }
  function save() {
    if (disabled || !valid || !dirty || conflict) return;
    $saveMutation.mutate({ ...$query.data, ...draft });
  }
</script>
<PolicyCard id={kind} title={retention ? "Log retention" : "Inactive-host removal"}
  scope={retention ? "Server cleanup · stored logs and statistics" : "Fleet lifecycle · registered hosts"}
  description={retention ? "Choose how long to keep logs and statistics before automatic removal." : "Remove hosts that have not checked in within the configured window."}
  details={retention ? "Retention removes old API logs, MCP logs, events and graph statistics. Disabling retention keeps those rows indefinitely; it preserves the configured durations." : "Set 0 to disable inactivity pruning. Temporary-host expiry and removal of hosts never provisioned within 30 minutes are separate lifecycle rules and still apply. Removed hosts must be registered again to return to the fleet."}>
  {#if retention}
    <div class="flex items-center justify-between gap-4">
      <div><label for="log-retention-enabled" class="text-sm font-medium">Enable automatic log removal</label><p class="mt-1 text-xs text-muted-foreground">Changes apply immediately using saved durations.</p></div>
      {#key `${$toggleMutation.status}:${$query.data?.enabled}`}
        <Switch id="log-retention-enabled" checked={$query.data?.enabled ?? false} {disabled} onCheckedChange={(value) => $toggleMutation.mutate(value)} />
      {/key}
    </div>
    <p role="status" class="text-sm text-muted-foreground">
      {#if $toggleMutation.isPending}Saving…
      {:else if $toggleMutation.isError}<span class="text-destructive">Save failed: {$toggleMutation.error.message}. The saved value is unchanged.</span>
      {:else if $query.isSuccess}{$query.data.enabled ? "Automatic removal enabled" : "Automatic removal disabled · logs kept indefinitely"}{#if $toggleMutation.isSuccess} · Saved{/if}{/if}
    </p>
  {/if}
  {#if $query.isPending}<p role="status" class="text-sm text-muted-foreground">Loading current policy…</p>
  {:else if $query.isError}<p role="alert" class="text-sm text-destructive">Could not load policy: {$query.error.message}</p><Button variant="outline" size="sm" onclick={() => void $query.refetch()}>Retry loading</Button>
  {:else}
    <form onsubmit={(event) => { event.preventDefault(); save(); }} class="space-y-4">
      <div class="grid gap-4 sm:grid-cols-2">
        {#each fields as field}
          <div class="space-y-1.5">
            <label class="text-sm font-medium" for={`${kind}-${field.key}`}>{field.label} (days)</label>
            <Input id={`${kind}-${field.key}`} type="number" min={retention ? 1 : 0} max={retention ? 365 : 60} step={1}
              bind:value={draft[field.key]} {disabled} aria-invalid={!!errors[field.key]}
              aria-describedby={`${kind}-${field.key}-hint`} oninput={() => $saveMutation.reset()} />
            <p id={`${kind}-${field.key}-hint`} class={errors[field.key] ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {errors[field.key] || (retention ? "1–365 days. Applied when automatic removal is enabled." : "0–60 days. Set 0 to disable inactivity pruning.")}
            </p>
          </div>
        {/each}
      </div>
      {#if conflict}<p role="alert" class="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">Saved values changed elsewhere. Your draft is preserved. Reset to load the latest values before editing again.</p>{/if}
      <div class="flex flex-wrap items-center gap-3">
        <Button size="sm" type="submit" disabled={disabled || !dirty || !valid || conflict}>Save changes</Button>
        <Button size="sm" variant="outline" type="button" onclick={reset} disabled={busy || !dirty}>Reset</Button>
        <p role="status" class="text-sm text-muted-foreground">
          {#if $saveMutation.isPending}Saving…
          {:else if $saveMutation.isError}<span class="text-destructive">Save failed: {$saveMutation.error.message}</span>
          {:else if dirty}Unsaved changes
          {:else if retention}{ $saveMutation.isSuccess ? "Saved" : "Saved durations" }
          {:else}{#if $saveMutation.isSuccess}Saved · {/if}Current policy: {$query.data.inactivity_window_days === 0 ? "inactivity pruning disabled" : `remove after ${$query.data.inactivity_window_days} days`}{/if}
        </p>
      </div>
    </form>
  {/if}
  {#if !$authStore.can("settings.manage")}<p class="text-xs text-muted-foreground">Read only. Requires settings.manage.</p>{/if}
</PolicyCard>
