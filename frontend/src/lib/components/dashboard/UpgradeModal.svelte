<script lang="ts">
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
  } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import ExternalLink from "@lucide/svelte/icons/external-link";

  type Props = {
    open: boolean;
    currentVersion?: string | null;
    availableVersion?: string | null;
    notes?: string | null;
    releaseUrl?: string | null;
    onOpenChange?: (open: boolean) => void;
  };

  let {
    open = $bindable(false),
    currentVersion,
    availableVersion,
    notes,
    releaseUrl,
    onOpenChange,
  }: Props = $props();

  const githubUrl = $derived(
    releaseUrl ??
      (availableVersion
        ? `https://github.com/christianreiss/codex-orchestrator/releases/tag/${encodeURIComponent(availableVersion)}`
        : "https://github.com/christianreiss/codex-orchestrator/releases"),
  );
</script>

<Dialog bind:open onOpenChange={(v) => onOpenChange?.(v)}>
  <DialogContent class="max-w-xl">
    <DialogHeader>
      <DialogTitle>Update available</DialogTitle>
      <DialogDescription>
        {#if currentVersion && availableVersion}
          Codex orchestrator <span class="font-mono">{availableVersion}</span> is ready. You are currently
          running <span class="font-mono">{currentVersion}</span>.
        {:else if availableVersion}
          Codex orchestrator <span class="font-mono">{availableVersion}</span> is ready.
        {:else}
          A new version is ready.
        {/if}
      </DialogDescription>
    </DialogHeader>
    <div class="max-h-72 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
      {#if notes && notes.trim() !== ""}
        <pre class="whitespace-pre-wrap font-sans text-sm leading-relaxed">{notes}</pre>
      {:else}
        <p class="text-muted-foreground">No release notes were returned by the update probe. See the release page on GitHub for the full changelog.</p>
      {/if}
    </div>
    <DialogFooter class="gap-2 sm:gap-2">
      <Button variant="outline" onclick={() => (open = false)}>Dismiss</Button>
      <Button href={githubUrl} target="_blank" rel="noopener noreferrer">
        Open on GitHub
        <ExternalLink class="ml-2 h-4 w-4" />
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
