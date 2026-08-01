<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import { FormField } from "$lib/components/ui/form-field";
  import RepeatableRows from "$lib/components/authoring/RepeatableRows.svelte";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { scalingMutation, scalingQuery } from "$lib/api/settings";
  import { REASONING_EFFORT_OPTIONS } from "$lib/constants/models";
  import type { ScalingLane, ScalingReasoningEffort, ScalingTierRule } from "$lib/api/types";

  const query = scalingQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = scalingMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Scaling rules saved");
    },
    onError: (err) => toast.error(err.message),
  });

  let enabled = $state(false);
  let tiers = $state<ScalingTierRule[]>([]);
  let tierErrors = $state<string | null>(null);
  let initialized = false;

  $effect(() => {
    const d = $query.data;
    if (!d || initialized) return;
    enabled = Boolean(d.enabled);
    tiers = d.rules?.tiers ?? [];
    initialized = true;
  });

  const LANES: Array<{ value: ScalingLane; label: string }> = [
    { value: "normal", label: "Normal" },
    { value: "spark", label: "Spark" },
  ];
  const REASONING_EFFORTS = REASONING_EFFORT_OPTIONS as Array<{
    value: ScalingReasoningEffort;
    label: string;
  }>;

  function newTier(): ScalingTierRule {
    return { at_percent: 0 };
  }

  function save() {
    tierErrors = null;
    for (const [i, t] of tiers.entries()) {
      if (!Number.isFinite(t.at_percent) || t.at_percent < 0 || t.at_percent > 100) {
        tierErrors = `Tier ${i + 1}: threshold must be between 0 and 100`;
        return;
      }
    }
    // Tiers must be strictly ordered for currentStatus()'s "highest at_percent
    // reached" scan to pick the right one — sort before submitting rather
    // than relying on the backend's own sort to save admins from a
    // silently-reordered read-back that doesn't match what they typed.
    const sorted = [...tiers].sort((a, b) => a.at_percent - b.at_percent);
    $mutation.mutate({ enabled, tiers: sorted });
  }

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="scaling"
  title="Scaling"
  description="Usage-driven autoscaling. Each tier applies once fleet usage reaches its threshold, in ascending order."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message ?? tierErrors ?? $query.error?.message}
>
  <SwitchRow
    id="scaling-enabled"
    label="Enable autoscaling"
    description="When off, the tiers below are stored but inactive."
    checked={enabled}
    onCheckedChange={(v) => (enabled = v)}
  />

  <RepeatableRows
    bind:rows={tiers}
    newRow={newTier}
    addLabel="Add tier"
    disabled={$query.isPending || $mutation.isPending}
  >
    {#snippet row(tier, i, patch)}
      <div class="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-4">
        <FormField id={`scaling-tier-${i}-percent`} label="At %" class="sm:col-span-1">
          <Input
            id={`scaling-tier-${i}-percent`}
            type="number"
            min={0}
            max={100}
            value={tier.at_percent}
            oninput={(e) => patch({ at_percent: Number(e.currentTarget.value) })}
          />
        </FormField>

        <FormField id={`scaling-tier-${i}-lane`} label="Lane" class="sm:col-span-1">
          <Select.Root
            type="single"
            value={tier.lane ?? ""}
            onValueChange={(v) => patch({ lane: (v || undefined) as ScalingLane | undefined })}
          >
            <Select.Trigger id={`scaling-tier-${i}-lane`}>
              <Select.Value placeholder="Inherit">
                {LANES.find((l) => l.value === tier.lane)?.label ?? "Inherit"}
              </Select.Value>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="" label="Inherit">Inherit</Select.Item>
              {#each LANES as l (l.value)}
                <Select.Item value={l.value} label={l.label}>{l.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </FormField>

        <FormField id={`scaling-tier-${i}-effort`} label="Reasoning effort" class="sm:col-span-1">
          <Select.Root
            type="single"
            value={tier.reasoning_effort ?? ""}
            onValueChange={(v) =>
              patch({ reasoning_effort: (v || undefined) as ScalingReasoningEffort | undefined })}
          >
            <Select.Trigger id={`scaling-tier-${i}-effort`}>
              <Select.Value placeholder="Inherit">
                {REASONING_EFFORTS.find((r) => r.value === tier.reasoning_effort)?.label ??
                  "Inherit"}
              </Select.Value>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="" label="Inherit">Inherit</Select.Item>
              {#each REASONING_EFFORTS as r (r.value)}
                <Select.Item value={r.value} label={r.label}>{r.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </FormField>

        <FormField id={`scaling-tier-${i}-model`} label="Model override" class="sm:col-span-1">
          <Input
            id={`scaling-tier-${i}-model`}
            placeholder="Inherit"
            value={tier.model ?? ""}
            oninput={(e) => patch({ model: e.currentTarget.value || null })}
          />
        </FormField>
      </div>
    {/snippet}
  </RepeatableRows>

  <div class="pt-2">
    <Button
      size="sm"
      onclick={save}
      disabled={$query.isPending || $query.isError || $mutation.isPending}>Save scaling</Button
    >
  </div>
</SectionCard>
