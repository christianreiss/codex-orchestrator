<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { remoteExecMutation, remoteExecQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = remoteExecQuery();
  const mutation = remoteExecMutation();

  const description = $derived.by(() => {
    const base =
      "Reserved command surface. Remote jobs and SSH transport are not implemented; every operational cxx remote command returns E_NOT_IMPLEMENTED. Ordinary SSH access is unaffected.";
    if ($query.isPending) return `${base} Loading…`;
    return $query.data?.enabled
      ? `${base} The parser is enabled; agents are told the feature is unavailable.`
      : `${base} The reserved parser is disabled.`;
  });
</script>

<SettingRow
  id="remote-exec"
  {bordered}
  label="Remote execution (unavailable)"
  {description}
  checked={$query.data?.enabled ?? false}
  disabled={$query.isPending}
  onCheckedChange={(v) => $mutation.mutateAsync(v)}
/>
