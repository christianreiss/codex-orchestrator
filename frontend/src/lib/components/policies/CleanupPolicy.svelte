<script lang="ts">
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { untrack } from "svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { api } from "$lib/api/client";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import PolicyRow from "./PolicyRow.svelte";

  type Values = { inactivity_window_days?: number };
  const kind = "prune-policy";
  const fields = [{ key: "inactivity_window_days" as const, label: "Inactivity window" }];
  const qc = useQueryClient();
  // Pruning reads overview because there is no dedicated GET.
  // settings.changed invalidates the existing settings query root.
  const queryKey = ["settings", kind];
  const query = createQuery<Values>({ queryKey, queryFn: async () => {
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
    !Number.isInteger(draft[key]) || Number(draft[key]) < 0 || Number(draft[key]) > 60
      ? `Enter a whole number from 0 to 60.` : ""
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
    mutationFn: (value) => api.post<Values>(`/admin/${kind}`, { inactivity_days: value.inactivity_window_days }),
    onSuccess: (data) => { adopt(data); accept(data); },
    onSettled: () => { void qc.invalidateQueries({ queryKey }); },
  });
  const busy = $derived($saveMutation.isPending);
  const disabled = $derived(!$authStore.can("settings.manage") || !$query.isSuccess || $query.isFetching || busy);
  function reset() { if ($query.data) adopt($query.data); $saveMutation.reset(); }
  function save() {
    if (disabled || !valid || !dirty || conflict) return;
    $saveMutation.mutate({ ...$query.data, ...draft });
  }
</script>
<DraftGuard {dirty} />
<PolicyRow
  id={kind}
  label="Remove inactive hosts"
  term="prune policy"
  help="Hosts that have not checked in within this many days are removed; 0 turns it off."
  details="Set 0 to disable inactivity pruning. Temporary-host expiry and removal of hosts never provisioned within 30 minutes are separate lifecycle rules and still apply. Removed hosts must be registered again to return to the fleet."
>
  {#if $query.isPending}<p role="status" class="text-body-sm text-muted-foreground">Loading current setting…</p>
  {:else if $query.isError}<p role="alert" class="text-body-sm text-destructive">Could not load setting: {$query.error.message}</p><Button variant="outline" size="sm" class="mt-1" onclick={() => void $query.refetch()}>Retry loading</Button>
  {:else}
    <form onsubmit={(event) => { event.preventDefault(); save(); }} class="mt-3 space-y-3">
      <div class="max-w-48">
        {#each fields as field}
          <div class="space-y-1">
            <label class="text-body-sm font-medium" for={`${kind}-${field.key}`}>{field.label} (days)</label>
            <Input id={`${kind}-${field.key}`} type="number" min={0} max={60} step={1}
              bind:value={draft[field.key]} {disabled} aria-invalid={!!errors[field.key]}
              aria-describedby={`${kind}-${field.key}-hint`} oninput={() => $saveMutation.reset()} />
            <p id={`${kind}-${field.key}-hint`} class={errors[field.key] ? "text-caption text-destructive" : "text-caption text-muted-foreground"}>
              {errors[field.key] || "0–60 days. 0 disables it."}
            </p>
          </div>
        {/each}
      </div>
      {#if conflict}<p role="alert" class="rounded-md border border-warning/40 bg-warning/10 p-3 text-body-sm">Saved values changed elsewhere. Your draft is preserved. Reset to load the latest values before editing again.</p>{/if}
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={disabled || !dirty || !valid || conflict}>Save changes</Button>
        <Button size="sm" variant="outline" type="button" onclick={reset} disabled={busy || !dirty}>Reset</Button>
        <p role="status" class="text-body-sm text-muted-foreground">
          {#if $saveMutation.isPending}Saving…
          {:else if $saveMutation.isError}<span class="text-destructive">Save failed: {$saveMutation.error.message}</span>
          {:else if dirty}Unsaved changes
          {:else}{#if $saveMutation.isSuccess}Saved · {/if}Current: {$query.data.inactivity_window_days == null ? "not reported" : $query.data.inactivity_window_days === 0 ? "inactivity pruning disabled" : `remove after ${$query.data.inactivity_window_days} ${$query.data.inactivity_window_days === 1 ? "day" : "days"}`}{/if}
        </p>
      </div>
    </form>
  {/if}
</PolicyRow>
