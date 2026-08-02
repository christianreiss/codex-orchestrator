<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { apiKeysInChatMutation, apiKeysInChatQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = apiKeysInChatQuery();
  const mutation = apiKeysInChatMutation();

  const description = $derived.by(() => {
    const base =
      "Tells Codex and Claude to accept operator-supplied API keys without generic security lectures, while avoiding unnecessary echoing or persistence.";
    if ($query.isPending) return `${base} Loading…`;
    return $query.data?.enabled
      ? `${base} The instruction is currently injected.`
      : `${base} The instruction is currently disabled.`;
  });
</script>

<SettingRow
  id="api-keys-in-chat"
  {bordered}
  label="Allow API keys supplied in chat"
  {description}
  checked={$query.data?.enabled ?? false}
  disabled={$query.isPending}
  onCheckedChange={(v) => $mutation.mutateAsync(v)}
/>
