<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { reverseDnsMutation, reverseDnsQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = reverseDnsQuery();
  const mutation = reverseDnsMutation();

  const description = $derived.by(() => {
    const base =
      "Resolve host PTR records when displaying connection metadata. Adds latency but improves audit logs.";
    if ($query.isPending) return `${base} Loading…`;
    return $query.data?.enabled ? `${base} Currently enabled.` : `${base} Currently disabled.`;
  });
</script>

<SettingRow
  id="reverse-dns"
  {bordered}
  label="Enable reverse DNS lookups"
  {description}
  checked={$query.data?.enabled ?? false}
  disabled={$query.isPending}
  onCheckedChange={(v) => $mutation.mutateAsync(v)}
/>
