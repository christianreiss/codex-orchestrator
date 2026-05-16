<script lang="ts">
  import { toast } from "svelte-sonner";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { openaiStateMutation, openaiStateQuery, codexVersionsQuery } from "$lib/api/settings";

  const query = openaiStateQuery();
  const versions = codexVersionsQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = openaiStateMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("OpenAI engine updated");
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

  const codexVersion = $derived($versions.data?.versions?.client_version ?? null);
</script>

<SectionCard
  id="openai-engine"
  title="OpenAI engine"
  description="Toggle OpenAI/Codex traffic independent of the master API kill-switch."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <SwitchRow
    id="openai-state-toggle"
    label="Disable OpenAI engine"
    description={$query.isPending
      ? "Loading…"
      : data?.disabled
        ? "OpenAI / Codex routes are disabled."
        : "OpenAI / Codex routes are enabled."}
    checked={data?.disabled ?? false}
    disabled={$query.isPending || $mutation.isPending}
    onCheckedChange={(value) => $mutation.mutate(value)}
  />
  <div class="rounded-md border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
    <span class="font-medium text-foreground">Current Codex version:</span>
    {#if $versions.isPending}
      Loading…
    {:else if codexVersion}
      <code class="rounded bg-muted px-1.5 py-0.5 font-mono">{codexVersion}</code>
    {:else}
      <span class="italic">unknown</span>
    {/if}
  </div>
</SectionCard>
