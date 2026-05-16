<script lang="ts">
  import { toast } from "svelte-sonner";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { cdxSilentMutation, cdxSilentQuery } from "$lib/api/settings";

  const query = cdxSilentQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = cdxSilentMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Silent mode updated");
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
  id="cdx-silent"
  title="Codex silent mode"
  description="Suppresses non-essential output from cdx CLI invocations across the fleet."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="cdx-silent-toggle"
    label="Silence cdx CLI output"
    description={$query.isPending
      ? "Loading…"
      : $query.data?.silent
        ? "cdx CLI output is suppressed."
        : "cdx CLI output is normal."}
    checked={$query.data?.silent ?? false}
    disabled={$query.isPending || $mutation.isPending}
    onCheckedChange={(v) => $mutation.mutate(v)}
  />
</SectionCard>
