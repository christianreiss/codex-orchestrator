<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { apiStateMutation, apiStateQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = apiStateQuery();
  const mutation = apiStateMutation();
  const data = $derived($query.data);

  const description = $derived.by(() => {
    const base = "Master kill-switch for all orchestrator API traffic.";
    if ($query.isPending) return `${base} Loading current state…`;
    if ($query.isError) return `${base} Failed to load: ${$query.error?.message ?? "unknown"}`;
    return data?.disabled
      ? `${base} Disabled — every engine endpoint returns 503 except admin CLI auth.`
      : `${base} Currently enabled.`;
  });
</script>

<SettingRow
  id="api-state"
  {bordered}
  label="Disable all API traffic"
  {description}
  checked={data?.disabled ?? false}
  disabled={$query.isPending}
  onCheckedChange={(value) => $mutation.mutateAsync(value)}
/>
