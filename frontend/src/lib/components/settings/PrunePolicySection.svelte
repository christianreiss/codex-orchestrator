<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { FormField } from "$lib/components/ui/form-field";
  import SectionCard from "./SectionCard.svelte";
  import { prunePolicyMutation } from "$lib/api/settings";
  import { overviewQuery } from "$lib/api/overview";

  // No dedicated GET endpoint exists for the prune policy; hydrate from the
  // same `inactivity_window_days` field /admin/overview already exposes.
  const query = overviewQuery();
  let inactivityDays = $state<number>(30);
  let initialized = false;
  $effect(() => {
    const d = $query.data;
    if (!d || initialized) return;
    inactivityDays = d.inactivity_window_days ?? 30;
    initialized = true;
  });

  let rangeError = $state<string | null>(null);
  let lastSavedAt = $state<Date | null>(null);

  const mutation = prunePolicyMutation({
    onSuccess: (data) => {
      lastSavedAt = new Date();
      // The server clamps out-of-range input rather than rejecting it —
      // always redisplay what it actually stored, not what was submitted.
      if (data && typeof data.inactivity_window_days === "number") {
        inactivityDays = data.inactivity_window_days;
      }
      toast.success("Prune policy saved");
    },
    onError: (err) => toast.error(err.message),
  });

  function save() {
    rangeError = null;
    if (!Number.isFinite(inactivityDays) || inactivityDays < 0 || inactivityDays > 60) {
      rangeError = "Must be an integer between 0 and 60";
      return;
    }
    $mutation.mutate({ inactivity_days: Math.round(inactivityDays) });
  }

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="prune-policy"
  title="Prune policy"
  description="Hosts that haven't checked in within this window are treated as inactive and pruned."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message ?? rangeError}
>
  <FormField
    id="prune-policy-days"
    label="Inactivity window (days)"
    hint="0–60. Hosts silent for longer than this are pruned."
    error={rangeError ?? undefined}
    class="max-w-xs"
  >
    <Input
      id="prune-policy-days"
      type="number"
      min={0}
      max={60}
      step={1}
      bind:value={inactivityDays}
      disabled={$query.isPending}
      aria-describedby={rangeError ? "prune-policy-days-error" : "prune-policy-days-hint"}
      aria-invalid={rangeError ? "true" : undefined}
    />
  </FormField>

  <div class="pt-2">
    <Button size="sm" onclick={save} disabled={$query.isPending || $mutation.isPending}>
      Save prune policy
    </Button>
  </div>
</SectionCard>
