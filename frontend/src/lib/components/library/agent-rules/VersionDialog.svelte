<script lang="ts">
  /** Read-only look at one stored version before deciding to restore it. */
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Dialog from "$lib/components/ui/dialog";
  import type { RulesHistoryState } from "./rules-history.svelte";

  let { history }: { history: RulesHistoryState } = $props();
  const version = $derived(history.viewingVersion);
</script>

<Dialog.Root open={!!version} onOpenChange={(open) => { if (!open) history.closeVersion(); }}>
  <Dialog.Content class="sm:max-w-3xl">
    <Dialog.Header>
      <Dialog.Title>Version #{version?.id}</Dialog.Title>
      <Dialog.Description>Read-only preview. Use "Make current" to restore this version as the new active document.</Dialog.Description>
    </Dialog.Header>
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
        <span>{version?.updated_at ? relativeTime(version.updated_at) : ""}</span>
        <span>·</span>
        <span class="font-mono">sha256: {version?.sha256?.slice(0, 12)}…</span>
        <span>·</span>
        <span>{formatBytes(version?.size_bytes ?? 0)}</span>
      </div>
      <Textarea aria-label="Version preview" class="min-h-[50vh] font-mono text-caption" readonly value={version?.content ?? ""} />
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => history.closeVersion()}>Close</Button>
      <Button onclick={() => history.makeVersionCurrent()} disabled={history.reverting}>Make current</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
