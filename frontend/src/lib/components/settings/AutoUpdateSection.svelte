<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { autoUpdateMutation, autoUpdateQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = autoUpdateQuery();
  const mutation = autoUpdateMutation();

  const description = $derived.by(() => {
    const base =
      "When enabled, hosts install the fleet target in the background. Maintenance checks every 15 minutes; starting a session never waits for an upgrade.";
    if ($query.isPending) return `${base} Loading…`;
    return $query.data?.enabled
      ? `${base} Hosts will auto-apply the pinned version.`
      : `${base} Hosts will not auto-apply updates.`;
  });
</script>

<SettingRow
  id="auto-update"
  {bordered}
  label="Enable fleet auto-update"
  {description}
  checked={$query.data?.enabled ?? false}
  disabled={$query.isPending}
  onCheckedChange={(v) => $mutation.mutateAsync(v)}
/>
