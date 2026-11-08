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
  let requestGeneration = 0;
  let assistError = $state<string | null>(null);
  const skillSnapshot = () => JSON.stringify(skill);
  type Request = { generation: number; snapshot: string; skill: SkillDraft; text: string };
  function request(text: string): Request { assistError = null; return { generation: ++requestGeneration, snapshot: skillSnapshot(), skill: { ...skill }, text: text.trim() }; }
  function isCurrent(request: Request) { return open && request.generation === requestGeneration && request.snapshot === skillSnapshot(); }

  const draft = createMutation({
    mutationFn: (request: Request) => skillsApi.generate({ prompt: request.text, slug_hint: request.skill.slug }),
    onSuccess: (result, request) => {
      if (!isCurrent(request)) return;
      onDraft(result);
      toast.success("Manifest generated");
      close();
    },
    onError: (err: unknown, request) => { if (isCurrent(request)) assistError = err instanceof ApiError ? err.message : "Failed to generate manifest"; },
  });

  const ask = createMutation({
    mutationFn: (request: Request) =>
      skillsApi.assist({
        mode: "edit",
        messages: [{ role: "user", content: request.text }],
        skill: { slug: request.skill.slug, manifest: request.skill.manifest, display_name: request.skill.displayName, description: request.skill.description },
      }),
    onSuccess: (result, request) => {
      if (!isCurrent(request)) return;
      reply = result.assistant_message?.content ?? result.manifest ?? "(no reply)";
    },
    onError: (err: unknown, request) => { if (isCurrent(request)) assistError = err instanceof ApiError ? err.message : "Failed to fetch assistant reply"; },
  });

  function close() {
    requestGeneration++;
    open = false;
    prompt = question = "";
    reply = null; assistError = null;
  }

  function applyManifest() {
    const manifest = $ask.data?.manifest;
    if (!$ask.variables || !isCurrent($ask.variables)) { assistError = "The skill changed since this reply. Ask again before replacing the current draft."; return; }
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
  <Dialog.Content size="xl">
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
          disabled={$draft.isPending || $ask.isPending}
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

    {#if assistError}<p role="alert" class="text-body-sm text-destructive">{assistError}</p>{/if}
    {#if mode === "draft"}
      <Textarea class="min-h-36" aria-label="Skill description for the draft" placeholder="e.g. coordinate multi-step refactors on PHP repositories…" bind:value={prompt} disabled={$draft.isPending || $ask.isPending} />
      <Dialog.Footer>
        <Button variant="outline" onclick={close}>Cancel</Button>
        <Button disabled={$draft.isPending || !prompt.trim()} onclick={() => $draft.mutate(request(prompt))}>
          {$draft.isPending ? "Generating…" : "Generate manifest"}
        </Button>
      </Dialog.Footer>
    {:else}
      <div class="space-y-3">
        <Textarea rows={3} aria-label="Question about the skill" placeholder="e.g. tighten the When-to-use section…" bind:value={question} disabled={$draft.isPending || $ask.isPending} />
        <Button size="sm" disabled={$ask.isPending || !question.trim()} onclick={() => $ask.mutate(request(question))}>
          {$ask.isPending ? "Thinking…" : "Ask"}
        </Button>
        {#if reply}
          <div class="rounded-md border bg-muted/50 p-3">
            <h4 class="section-label mb-2">Assistant reply</h4>
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
