<script lang="ts">
  import { toast } from "svelte-sonner";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { reverseDnsMutation, reverseDnsQuery } from "$lib/api/settings";

  const query = reverseDnsQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = reverseDnsMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Reverse DNS updated");
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
  id="reverse-dns"
  title="Reverse DNS"
  description="Resolve host PTR records when displaying connection metadata. Adds latency but improves audit logs."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="reverse-dns-toggle"
    label="Enable reverse DNS lookups"
    description={$query.isPending
      ? "Loading…"
      : $query.data?.enabled
        ? "Reverse DNS is enabled."
        : "Reverse DNS is disabled."}
    checked={$query.data?.enabled ?? false}
    disabled={$query.isPending || $mutation.isPending}
    onCheckedChange={(v) => $mutation.mutate(v)}
  />
</SectionCard>
