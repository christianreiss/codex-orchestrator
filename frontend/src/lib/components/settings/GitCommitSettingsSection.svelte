<script lang="ts">
  import { SimpleSelect } from "$lib/components/ui/select";
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
  description="How agents write commit messages. Applies to every enabled engine, independent of the Director switch."
>
  {#snippet actions()}
    <SaveIndicator {status} savedAt={lastSavedAt} error={$mutation.error?.message ?? $query.error?.message} />
  {/snippet}

  <div class="grid gap-3 sm:grid-cols-2">
    <div class="space-y-1">
      <Label for="git-commit-style">Message length</Label>
      <!-- Controlled: stays on the saved value until the server confirms a change. -->
      <SimpleSelect
        id="git-commit-style"
        aria-label="Message length"
        class="w-full"
        value={data?.message_style ?? "short"}
        {disabled}
        onValueChange={(value) => { if (data) $mutation.mutate({ ...data, message_style: value === "long" ? "long" : "short" }); }}
        options={[{ value: "short", label: "Short" }, { value: "long", label: "Long" }]}
      />
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
          <SimpleSelect id="git-preview-engine" aria-label="Engine" bind:value={previewEngine} class="h-8" options={["Codex", "Claude", "Grok", "Kimi Code"].map((engine) => ({ value: engine, label: engine }))} />
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
