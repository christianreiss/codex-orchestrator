<script lang="ts">
  import { toast } from "svelte-sonner";
  import { authStore } from "$lib/stores/auth";
  import { gitCommitSettingsMutation, gitCommitSettingsQuery } from "$lib/api/gitDirector";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";

  const query = gitCommitSettingsQuery();
  let lastSavedAt = $state<Date | null>(null);
  const mutation = gitCommitSettingsMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Commit preferences saved; hosts pick them up on their next sync or launch");
    },
    onError: (error) => toast.error(error.message),
  });
  const data = $derived($query.data);
  const disabled = $derived(!$authStore.can("git_director.manage") || !data || $mutation.isPending || $query.isFetching);
  const status = $derived($mutation.isPending ? "saving" : $mutation.isError ? "error" : $mutation.isSuccess ? "saved" : "idle");
  function preview(engine: string) {
    return "Fix stale host status"
      + (data?.message_style === "long"
        ? "\n\nRefresh host status after configuration changes so the dashboard shows the current state."
        : "")
      + (data?.ai_attribution ? `\n\nAI-Assisted-By: ${engine}` : "");
  }
</script>

<SectionCard
  id="git-commit-messages"
  title="Commit messages"
  description="Shared preferences for Codex, Claude and Grok. Applies even when the Git Director or Skills are disabled. Defaults: short messages, AI attribution off."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message ?? $query.error?.message}
>
  <div class="flex items-center justify-between gap-4">
    <div>
      <label for="git-commit-style" class="text-sm font-medium">Message length</label>
      <p class="text-xs text-muted-foreground">Short: subject only. Long: subject, change and reason, plus relevant verification.</p>
    </div>
    <select
      id="git-commit-style"
      class="rounded-md border border-input bg-background px-3 py-2 text-sm"
      value={data?.message_style ?? "short"}
      {disabled}
      onchange={(event) => {
        const message_style = event.currentTarget.value === "long" ? "long" : "short";
        // Keep the control on the saved value until the server confirms it.
        // A failed save may refetch identical data, which would not reset a
        // native select's user-selected value by itself.
        event.currentTarget.value = data?.message_style ?? "short";
        if (data) $mutation.mutate({ ...data, message_style });
      }}
    >
      <option value="short">Short</option>
      <option value="long">Long</option>
    </select>
  </div>
  <!-- The shared switch retains internal state; recreate it when a save
       settles so a rejected change also returns to the saved value. -->
  {#key `${$mutation.status}:${data?.ai_attribution}`}
    <SwitchRow
      id="git-commit-attribution"
      label="AI Attribution"
      description="Append an AI-Assisted-By trailer naming the engine. Git author and committer stay unchanged."
      checked={data?.ai_attribution ?? false}
      {disabled}
      onCheckedChange={(ai_attribution) => {
        if (data) $mutation.mutate({ ...data, ai_attribution });
      }}
    />
  {/key}
  {#if data}
    <div class="grid gap-3 md:grid-cols-3">
      {#each ["Codex", "Claude", "Grok"] as engine}
        <div class="min-w-0 rounded-md border p-3">
          <p class="mb-2 text-xs font-medium">{engine} preview</p>
          <pre class="whitespace-pre-wrap break-words text-xs">{preview(engine)}</pre>
        </div>
      {/each}
    </div>
  {/if}
  <p class="text-xs text-muted-foreground">
    Delivered through managed AGENTS.md / CLAUDE.md on the next wrapper sync or launch.
    Explicit operator instructions take precedence. These preferences do not authorize commits or pushes.
  </p>
</SectionCard>
