<script lang="ts">
  import type { QuotaAdviceSettings } from "$lib/api/types";
  import { Switch } from "$lib/components/ui/switch";
  import { toast } from "svelte-sonner";
  import * as Select from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "./SectionCard.svelte";
  import { quotaModeMutation, quotaModeQuery } from "$lib/api/settings";

  type Props = { headingLevel?: 2 | 3 };
  let { headingLevel = 2 }: Props = $props();

  const query = quotaModeQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = quotaModeMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Quotas updated");
    },
    onError: (err) => toast.error(err.message),
  });

  type Mode = "hard" | "soft";
  let mode = $state<Mode>("hard");
  let limitPercent = $state<number>(95);
  let weekPartition = $state<string>("off");
  let advice = $state<QuotaAdviceSettings>({
    mode: "ask", high_usage_percent: 85, projected_usage_percent: 100,
    min_pressure_gap: 20, max_age_minutes: 30, remember_day: true,
  });
  let initialized = false;

  $effect(() => {
    const d = $query.data;
    if (!d || initialized) return;
    mode = d.hard_fail ? "hard" : "soft";
    limitPercent = d.limit_percent;
    weekPartition = String(d.week_partition);
    if (d.advice) advice = { ...d.advice };
    initialized = true;
  });

  const labels: Record<Mode, string> = {
    hard: "Hard (reject over-quota)",
    soft: "Soft (allow with warning)",
  };

  function save() {
    $mutation.mutate({
      hard_fail: mode === "hard",
      limit_percent: Number(limitPercent),
      week_partition: weekPartition as "off" | "5" | "7",
      advice: { ...advice },
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
  description="Quota enforcement and provider recommendations at wrapper startup."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
  {headingLevel}
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
        </Select.Content>
      </Select.Root>
    </div>

    <div class="grid gap-1.5">
      <Label for="quota-limit">Limit percent</Label>
      <Input
        id="quota-limit"
        type="number"
        min={50}
        max={100}
        bind:value={limitPercent}
      />
    </div>

    <div class="grid gap-1.5">
      <Label for="quota-week-partition">Week partition</Label>
      <Select.Root
        type="single"
        value={weekPartition}
        onValueChange={(v) => (weekPartition = v)}
      >
        <Select.Trigger id="quota-week-partition">
          <Select.Value placeholder="Partition">
            {weekPartition === "off" ? "Off" : weekPartition + "-day"}
          </Select.Value>
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="off" label="Off">Off</Select.Item>
          <Select.Item value="5" label="5-day">5-day</Select.Item>
          <Select.Item value="7" label="7-day">7-day</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  <div class="grid gap-3 border-t pt-4 sm:grid-cols-2">
    <div class="grid gap-1.5 sm:col-span-2">
      <Label for="quota-advice-mode">Provider recommendation</Label>
      <Select.Root type="single" value={advice.mode} onValueChange={(v) => (advice.mode = v as QuotaAdviceSettings["mode"])}>
        <Select.Trigger id="quota-advice-mode"><Select.Value>{advice.mode === "ask" ? "Interactive choice" : advice.mode === "hint" ? "Hint only" : "Off"}</Select.Value></Select.Trigger>
        <Select.Content>
          <Select.Item value="ask">Interactive choice</Select.Item>
          <Select.Item value="hint">Hint only</Select.Item>
          <Select.Item value="off">Off</Select.Item>
        </Select.Content>
      </Select.Root>
      <p class="text-sm text-muted-foreground">Compares OpenAI and Claude usage and time until reset. Automated starts only show a hint. A switch opens a new session.</p>
    </div>
    <div class="grid gap-1.5">
      <Label for="advice-high">High usage (%)</Label>
      <Input id="advice-high" type="number" min={1} max={100} step={1} bind:value={advice.high_usage_percent} />
    </div>
    <div class="grid gap-1.5">
      <Label for="advice-projected">Critical estimated usage at reset (%)</Label>
      <Input id="advice-projected" type="number" min={100} max={500} step={1} bind:value={advice.projected_usage_percent} />
    </div>
    <div class="grid gap-1.5">
      <Label for="advice-gap">Minimum pressure difference (points)</Label>
      <Input id="advice-gap" type="number" min={1} max={100} step={1} bind:value={advice.min_pressure_gap} />
      <p class="text-sm text-muted-foreground">100 pressure points means a threshold is reached. The alternative must stay below 100.</p>
    </div>
    <div class="grid gap-1.5">
      <Label for="advice-age">Maximum measurement age (minutes)</Label>
      <Input id="advice-age" type="number" min={1} max={120} step={1} bind:value={advice.max_age_minutes} />
    </div>
    <div class="flex items-center gap-3 sm:col-span-2">
      <Switch id="advice-remember" checked={advice.remember_day} onCheckedChange={(v) => (advice.remember_day = v)} />
      <Label for="advice-remember">Allow remembering the provider until local midnight</Label>
    </div>
    <p class="text-sm text-muted-foreground sm:col-span-2">Remembered choices apply to this computer's user across cdx and clx. Use --quota-choice-reset to choose again.</p>
  </div>

  <div class="pt-2">
    <Button size="sm" onclick={save} disabled={$query.isPending || $query.isError || $mutation.isPending}>Save</Button>
  </div>
</SectionCard>
