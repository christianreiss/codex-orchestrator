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
  import type { VersionCount } from "$lib/api/overview";

  type Props = {
    open: boolean;
    availableVersion?: string | null;
    outdatedVersions?: VersionCount[];
    notes?: string | null;
    releaseUrl?: string | null;
    onOpenChange?: (open: boolean) => void;
  };

  let {
    open = $bindable(false),
    availableVersion,
    outdatedVersions = [],
    notes,
    releaseUrl,
    onOpenChange,
  }: Props = $props();

  const githubUrl = $derived(
    releaseUrl ??
      (availableVersion
        ? `https://github.com/openai/codex/releases/tag/rust-v${encodeURIComponent(availableVersion.replace(/^v/, ""))}`
        : "https://github.com/openai/codex/releases"),
  );
  const outdatedHostCount = $derived(outdatedVersions.reduce((sum, item) => sum + item.count, 0));
</script>

<Dialog bind:open onOpenChange={(v) => onOpenChange?.(v)}>
  <DialogContent class="max-w-xl">
    <DialogHeader>
      <DialogTitle>Codex CLI update available</DialogTitle>
      <DialogDescription>
        {#if availableVersion}
          Codex CLI <span class="font-mono">{availableVersion}</span> is the latest release.
          {outdatedHostCount} {outdatedHostCount === 1 ? "host reports" : "hosts report"} an older version.
        {:else}
          A new Codex CLI version is ready.
        {/if}
      </DialogDescription>
    </DialogHeader>
    {#if outdatedVersions.length > 0}
      <div class="rounded-md border bg-muted/30 p-3 text-sm">
        <p class="mb-2 font-medium">Reported older versions</p>
        <ul class="space-y-1 text-muted-foreground">
          {#each outdatedVersions as item (item.version)}
            <li><span class="font-mono text-foreground">{item.version}</span> · {item.count} {item.count === 1 ? "host" : "hosts"}</li>
          {/each}
        </ul>
      </div>
    {/if}
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
