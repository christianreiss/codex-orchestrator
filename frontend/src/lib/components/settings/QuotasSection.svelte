<script lang="ts">
  import { toast } from "svelte-sonner";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "./SectionCard.svelte";
  import { quotaModeMutation, quotaModeQuery } from "$lib/api/settings";

  const query = quotaModeQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = quotaModeMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Quotas updated");
    },
    onError: (err) => toast.error(err.message),
  });

  // Backend exposes hard_fail (bool) + limit_percent (int) + week_partition.
  // We model the policy as: hard (hard_fail=true, limit_percent ≥ 1),
  // soft (hard_fail=false, limit_percent ≥ 1), or disabled (limit_percent = 0).
  type Mode = "hard" | "soft" | "disabled";

  let mode = $state<Mode>("hard");
  let limitPercent = $state<number>(100);
  let weekPartition = $state<number>(7);
  let initialized = false;

  $effect(() => {
    const d = $query.data;
    if (!d || initialized) return;
    if (d.limit_percent === 0) mode = "disabled";
    else mode = d.hard_fail ? "hard" : "soft";
    limitPercent = d.limit_percent || 100;
    weekPartition = d.week_partition || 7;
    initialized = true;
  });

  const labels: Record<Mode, string> = {
    hard: "Hard (reject over-quota)",
    soft: "Soft (allow with warning)",
    disabled: "Disabled (no enforcement)",
  };

  function save() {
    $mutation.mutate({
      hard_fail: mode === "hard",
      limit_percent: mode === "disabled" ? 0 : Number(limitPercent),
      week_partition: Number(weekPartition),
    });
  }

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="quotas"
  title="Quotas"
  description="Controls how user quotas are enforced when over budget."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <div class="grid gap-3 sm:grid-cols-2">
    <div class="grid gap-1.5">
      <Label for="quota-mode">Enforcement mode</Label>
      <Select.Root type="single" value={mode} onValueChange={(v) => (mode = v as Mode)}>
        <Select.Trigger id="quota-mode">
          <Select.Value placeholder="Mode">{labels[mode]}</Select.Value>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="hard" label="Hard">Hard (reject over-quota)</Select.Item>
          <Select.Item value="soft" label="Soft">Soft (allow with warning)</Select.Item>
          <Select.Item value="disabled" label="Disabled">Disabled (no enforcement)</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>

    <div class="grid gap-1.5">
      <Label for="quota-limit">Limit percent</Label>
      <Input
        id="quota-limit"
        type="number"
        min={1}
        max={500}
        bind:value={limitPercent}
        disabled={mode === "disabled"}
      />
    </div>

    <div class="grid gap-1.5">
      <Label for="quota-week-partition">Week partition</Label>
      <Select.Root
        type="single"
        value={String(weekPartition)}
        onValueChange={(v) => (weekPartition = Number(v))}
      >
        <Select.Trigger id="quota-week-partition">
          <Select.Value placeholder="Partition">
            {weekPartition === 0 ? "Off" : weekPartition + "-day"}
          </Select.Value>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="0" label="Off">Off</Select.Item>
          <Select.Item value="5" label="5-day">5-day</Select.Item>
          <Select.Item value="7" label="7-day">7-day</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  <div class="pt-2">
    <Button size="sm" onclick={save} disabled={$query.isPending || $mutation.isPending}>Save</Button>
  </div>
</SectionCard>
