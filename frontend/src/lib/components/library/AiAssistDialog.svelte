<script lang="ts">
  /**
   * One "AI assist" entry point for skills. Two modes, each with its own
   * endpoint and its own apply semantics (they are not interchangeable):
   * "Draft" writes a full manifest from a description and replaces the editor
   * contents; "Ask" answers a question about the current manifest and may
   * offer a replacement manifest to apply.
   */
  import { createMutation } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { skillsApi } from "$lib/api/skills";
  import { ApiError } from "$lib/api/client";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Dialog from "$lib/components/ui/dialog";
  import { cn } from "$lib/utils/cn";

  type SkillDraft = { slug: string; manifest: string; displayName: string; description: string };
  type Props = {
    open: boolean;
    skill: SkillDraft;
    /** Replace the manifest (and fill the display name / description when empty). */
    onDraft: (result: { manifest?: string; display_name?: string; description?: string }) => void;
    onApplyManifest: (manifest: string) => void;
  };
  let { open = $bindable(), skill, onDraft, onApplyManifest }: Props = $props();

  let mode = $state<"draft" | "ask">("draft");
  let prompt = $state("");
  let question = $state("");
  let reply = $state<string | null>(null);

  const draft = createMutation({
    mutationFn: () => skillsApi.generate({ prompt: prompt.trim(), slug_hint: skill.slug }),
    onSuccess: (result) => {
      onDraft(result);
      toast.success("Manifest generated");
      close();
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to generate manifest"),
  });

  const ask = createMutation({
    mutationFn: () =>
      skillsApi.assist({
        mode: "edit",
        messages: [{ role: "user", content: question.trim() }],
        skill: { slug: skill.slug, manifest: skill.manifest, display_name: skill.displayName, description: skill.description },
      }),
    onSuccess: (result) => {
      reply = result.assistant_message?.content ?? result.manifest ?? "(no reply)";
    },
    onError: (err: unknown) => toast.error(err instanceof ApiError ? err.message : "Failed to fetch assistant reply"),
  });

  function close() {
    open = false;
    prompt = question = "";
    reply = null;
  }

  function applyManifest() {
    const manifest = $ask.data?.manifest;
    if (!manifest) return void toast.error("Assistant did not return a manifest");
    onApplyManifest(manifest);
    toast.success("Manifest replaced from assistant");
    close();
  }

  const modes = [
    { id: "draft", label: "Draft from a description" },
    { id: "ask", label: "Ask about this skill" },
  ] as const;
</script>

<Dialog.Root bind:open onOpenChange={(next) => { if (!next) close(); }}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>AI assist</Dialog.Title>
      <Dialog.Description>
        {mode === "draft"
          ? "Describe what this skill should do. The runner drafts a full manifest and replaces the editor contents."
          : "Ask for suggestions about the current manifest. The reply appears below; you choose whether to apply it."}
      </Dialog.Description>
    </Dialog.Header>

    <div class="inline-flex w-fit rounded-md border p-0.5" role="group" aria-label="AI assist mode">
      {#each modes as option (option.id)}
        <button
          type="button"
          aria-pressed={mode === option.id}
          onclick={() => (mode = option.id)}
          class={cn(
            "h-8 rounded-md px-3 text-body-sm transition-colors",
            mode === option.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      {/each}
    </div>

    {#if mode === "draft"}
      <Textarea class="min-h-36" aria-label="Skill description for the draft" placeholder="e.g. coordinate multi-step refactors on PHP repositories…" bind:value={prompt} />
      <Dialog.Footer>
        <Button variant="outline" onclick={close}>Cancel</Button>
        <Button disabled={$draft.isPending || !prompt.trim()} onclick={() => $draft.mutate()}>
          {$draft.isPending ? "Generating…" : "Generate manifest"}
        </Button>
      </Dialog.Footer>
    {:else}
      <div class="space-y-3">
        <Textarea rows={3} aria-label="Question about the skill" placeholder="e.g. tighten the When-to-use section…" bind:value={question} />
        <Button size="sm" disabled={$ask.isPending || !question.trim()} onclick={() => $ask.mutate()}>
          {$ask.isPending ? "Thinking…" : "Ask"}
        </Button>
        {#if reply}
          <div class="rounded-md border bg-muted/50 p-3">
            <h4 class="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">Assistant reply</h4>
            <pre class="max-h-[40vh] overflow-y-auto whitespace-pre-wrap font-mono text-body-sm">{reply}</pre>
            {#if $ask.data?.manifest}
              <div class="mt-2 flex justify-end">
                <Button size="sm" variant="outline" onclick={applyManifest}>Apply manifest</Button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <Dialog.Footer>
        <Button variant="outline" onclick={close}>Close</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
