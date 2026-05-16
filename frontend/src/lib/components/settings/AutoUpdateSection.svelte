<script lang="ts">
  import { toast } from "svelte-sonner";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { autoUpdateMutation, autoUpdateQuery } from "$lib/api/settings";

  const query = autoUpdateQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = autoUpdateMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Auto-update updated");
    },
    onError: (err) => toast.error(err.message),
  });

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="auto-update"
  title="Auto-update"
  description="When enabled, hosts pull and apply the latest pinned engine version automatically on their next sync."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="auto-update-toggle"
    label="Enable fleet auto-update"
    description={$query.isPending
      ? "Loading…"
      : $query.data?.enabled
        ? "Hosts will auto-apply the pinned version."
        : "Hosts will not auto-apply updates."}
    checked={$query.data?.enabled ?? false}
    disabled={$query.isPending || $mutation.isPending}
    onCheckedChange={(v) => $mutation.mutate(v)}
  />
</SectionCard>
