<script lang="ts">
  import { toast } from "svelte-sonner";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { apiStateMutation, apiStateQuery } from "$lib/api/settings";

  const query = apiStateQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = apiStateMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("API state updated");
    },
    onError: (err) => toast.error(err.message),
  });

  const data = $derived($query.data);
  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="api-state"
  title="API state"
  description="Master kill-switch for all orchestrator API traffic. When disabled, every engine endpoint returns 503 except admin CLI auth."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="api-state-toggle"
    label="Disable all API traffic"
    description={$query.isPending
      ? "Loading current state…"
      : $query.isError
        ? "Failed to load: " + ($query.error?.message ?? "unknown")
        : data?.disabled
          ? "API is currently disabled. All engine traffic returns 503."
          : "API is currently enabled."}
    checked={data?.disabled ?? false}
    disabled={$query.isPending || $mutation.isPending}
    onCheckedChange={(value) => $mutation.mutate(value)}
  />
</SectionCard>
