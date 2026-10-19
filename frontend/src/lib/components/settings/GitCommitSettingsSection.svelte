<script lang="ts">
  import { toast } from "svelte-sonner";
  import { authStore } from "$lib/stores/auth";
  import { gitCommitSettingsMutation, gitCommitSettingsQuery } from "$lib/api/gitDirector";
  import { Section } from "$lib/components/page";
  import { Label } from "$lib/components/ui/label";
  import SaveIndicator from "./SaveIndicator.svelte";
  import { filterClass } from "$lib/components/feedback/report-model";
  import SwitchRow from "./SwitchRow.svelte";

  let previewEngine = $state("Codex");
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

<Section
  id="git-commit-messages"
  title="Commit messages"
  description="How agents write commit messages. Applies to Codex, Claude and Grok, independent of the Director switch."
>
  {#snippet actions()}
    <SaveIndicator {status} savedAt={lastSavedAt} error={$mutation.error?.message ?? $query.error?.message} />
  {/snippet}

  <div class="grid gap-3 sm:grid-cols-2">
    <div class="space-y-1">
      <Label for="git-commit-style">Message length</Label>
      <select
        id="git-commit-style"
        class="{filterClass} w-full"
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
      <p class="text-caption text-muted-foreground">Short: subject only. Long: subject, change and reason, plus relevant verification.</p>
    </div>
    <!-- The shared switch retains internal state; recreate it when a save
         settles so a rejected change also returns to the saved value. -->
    {#key `${$mutation.status}:${data?.ai_attribution}`}
      <div class="space-y-1">
        <Label for="git-commit-attribution">AI attribution</Label>
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
      </div>
    {/key}
  </div>

  {#if data}
    <div class="mt-4 space-y-1.5">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-body-sm font-medium">Preview</h3>
        <div class="flex items-center gap-2">
          <Label for="git-preview-engine" class="text-caption text-muted-foreground">Engine</Label>
          <select id="git-preview-engine" bind:value={previewEngine} class="{filterClass} h-8">{#each ["Codex", "Claude", "Grok"] as engine}<option>{engine}</option>{/each}</select>
        </div>
      </div>
      <pre aria-label="Commit preview" class="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-caption">{preview(previewEngine)}</pre>
    </div>
  {/if}

  <details class="mt-3 text-body-sm text-muted-foreground">
    <summary class="cursor-pointer select-none font-medium text-foreground">How this reaches agents</summary>
    <p class="mt-2">
      Delivered through managed AGENTS.md / CLAUDE.md on the next wrapper sync or launch.
      Explicit operator instructions take precedence. These preferences do not authorize commits or pushes.
    </p>
  </details>
</Section>
