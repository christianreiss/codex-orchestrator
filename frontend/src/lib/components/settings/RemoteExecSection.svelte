<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { remoteExecMutation, remoteExecQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = remoteExecQuery();
  const mutation = remoteExecMutation();

  const description = $derived.by(() => {
    const base =
      "Lets agents drive other machines with cxx remote: one reused SSH connection per target, jobs that survive a dropped connection. It is a fleet control, not a boundary — an agent that can run cxx remote can already run ssh.";
    if ($query.isPending) return `${base} Loading…`;
    return $query.data?.enabled
      ? `${base} Hosts accept it and agents are told it exists.`
      : `${base} Hosts refuse it and agents are not told about it.`;
  });
</script>

<SettingRow
  id="remote-exec"
  {bordered}
  label="Allow remote execution over SSH"
  {description}
  checked={$query.data?.enabled ?? false}
  disabled={$query.isPending}
  onCheckedChange={(v) => $mutation.mutateAsync(v)}
/>
