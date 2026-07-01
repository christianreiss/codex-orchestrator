<script lang="ts">
  import { toast } from "svelte-sonner";
  import * as Select from "$lib/components/ui/select";
  import { Label } from "$lib/components/ui/label";
  import SectionCard from "./SectionCard.svelte";
  import { insecureApprovalMutation, insecureApprovalQuery } from "$lib/api/settings";

  const query = insecureApprovalQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = insecureApprovalMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Insecure approval policy updated");
    },
    onError: (err) => toast.error(err.message),
  });

  // Backend stores only a boolean `enabled`. The UI surfaces two
  // policy modes that map to that boolean: "manual" (admin approves
  // each insecure window) vs "reject" (no insecure windows allowed).
  type Mode = "manual" | "reject";
  const modeFromValue = (enabled: boolean | undefined): Mode => (enabled ? "manual" : "reject");

  const currentMode = $derived(modeFromValue($query.data?.enabled));

  function onValueChange(value: string) {
    if (value === "manual") $mutation.mutate(true);
    else if (value === "reject") $mutation.mutate(false);
  }

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });

  const labels: Record<Mode, string> = {
    manual: "Manual approval",
    reject: "Reject all",
  };
</script>

<SectionCard
  id="insecure-approval"
  title="Insecure approval policy"
  description="Controls whether hosts may open insecure browser windows. Manual approval requires an admin to confirm each request."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <div class="grid gap-2">
    <Label for="insecure-approval-mode">Policy</Label>
    <Select.Root
      type="single"
      value={currentMode}
      onValueChange={onValueChange}
      disabled={$query.isPending || $query.isError || $mutation.isPending}
    >
      <Select.Trigger id="insecure-approval-mode" class="w-full sm:max-w-sm">
        <Select.Value placeholder="Select policy">{labels[currentMode]}</Select.Value>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="manual" label="Manual approval">Manual approval</Select.Item>
        <Select.Item value="reject" label="Reject all">Reject all</Select.Item>
      </Select.Content>
    </Select.Root>
    <p class="text-xs text-muted-foreground">
      {$query.isPending
        ? "Loading current policy…"
        : $query.isError
          ? "Failed to load: " + ($query.error?.message ?? "unknown")
          : currentMode === "manual"
            ? "Each insecure window requires an admin to approve."
            : "Insecure windows are rejected automatically."}
    </p>
  </div>
</SectionCard>
