<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { scalingMutation, scalingQuery } from "$lib/api/settings";

  const query = scalingQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = scalingMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Scaling rules saved");
    },
    onError: (err) => toast.error(err.message),
  });

  let rulesJson = $state("{}");
  let enabled = $state(false);
  let parseError = $state<string | null>(null);
  let initialized = false;

  $effect(() => {
    const d = $query.data;
    if (!d || initialized) return;
    enabled = Boolean(d.enabled);
    const payload = d.rules ?? { enabled: d.enabled, tiers: [] };
    rulesJson = JSON.stringify(payload, null, 2);
    initialized = true;
  });

  function save() {
    parseError = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rulesJson);
    } catch (err) {
      parseError = err instanceof Error ? err.message : "Invalid JSON";
      toast.error("Invalid JSON: " + parseError);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      parseError = "Rules must be a JSON object";
      toast.error(parseError);
      return;
    }
    // Force the toggle value into the payload.
    const payload = { ...(parsed as Record<string, unknown>), enabled };
    $mutation.mutate(payload);
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
  description="Usage-driven autoscaling. The tier ruleset is edited as JSON to keep the field set flexible across schema revisions."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message ?? parseError}
>
  <SwitchRow
    id="scaling-enabled"
    label="Enable autoscaling"
    description="When off, the rules below are stored but inactive."
    checked={enabled}
    onCheckedChange={(v) => (enabled = v)}
  />

  <div class="grid gap-1.5">
    <Label for="scaling-rules">Rules (JSON)</Label>
    <Textarea
      id="scaling-rules"
      class="min-h-[180px] font-mono text-xs"
      bind:value={rulesJson}
      spellcheck={false}
      placeholder={`{\n  "enabled": true,\n  "tiers": []\n}`}
    />
    {#if parseError}
      <p class="text-xs text-destructive">{parseError}</p>
    {/if}
  </div>

  <div>
    <Button size="sm" onclick={save} disabled={$mutation.isPending}>Save scaling</Button>
  </div>
</SectionCard>
