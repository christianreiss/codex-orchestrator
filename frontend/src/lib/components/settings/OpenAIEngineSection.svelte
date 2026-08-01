<script lang="ts">
  import SettingRow from "./SettingRow.svelte";
  import { openaiStateMutation, openaiStateQuery, codexVersionsQuery } from "$lib/api/settings";

  type Props = { bordered?: boolean };
  let { bordered = true }: Props = $props();

  const query = openaiStateQuery();
  const versions = codexVersionsQuery();
  const mutation = openaiStateMutation();

  const data = $derived($query.data);
  const codexVersion = $derived($versions.data?.versions?.client_version ?? null);

  const description = $derived.by(() => {
    const base = "Toggle OpenAI/Codex traffic independent of the master API kill-switch.";
    if ($query.isPending) return `${base} Loading…`;
    return data?.disabled ? `${base} Currently disabled.` : `${base} Currently enabled.`;
  });
</script>

<SettingRow
  id="openai-engine"
  toggleId="openai-state-toggle"
  {bordered}
  label="Disable OpenAI engine"
  {description}
  checked={data?.disabled ?? false}
  disabled={$query.isPending}
  onCheckedChange={(value) => $mutation.mutateAsync(value)}
>
  {#snippet info()}
    <div class="rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
      <span class="font-medium text-foreground">Current Codex version:</span>
      {#if $versions.isPending}
        Loading…
      {:else if codexVersion}
        <code class="rounded bg-muted px-1.5 py-0.5 font-mono">{codexVersion}</code>
      {:else}
        <span class="italic">unknown</span>
      {/if}
    </div>
  {/snippet}
</SettingRow>
