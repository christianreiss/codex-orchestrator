<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { cdxSilentMutation, cdxSilentQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = cdxSilentQuery();
  const mutation = cdxSilentMutation();

  const description = $derived.by(() => {
    const base = "Suppresses non-essential output from cdx CLI invocations across the fleet.";
    if ($query.isPending) return `${base} Loading…`;
    return $query.data?.silent ? `${base} Currently suppressed.` : `${base} Currently normal.`;
  });
</script>

<SettingRow
  id="cdx-silent"
  {bordered}
  label="Silence cdx CLI output"
  {description}
  checked={$query.data?.silent ?? false}
  disabled={$query.isPending}
  onCheckedChange={(v) => $mutation.mutateAsync(v)}
/>
