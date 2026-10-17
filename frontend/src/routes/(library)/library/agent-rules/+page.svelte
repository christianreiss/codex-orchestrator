<script lang="ts">
  import Eye from "@lucide/svelte/icons/eye";
  import History from "@lucide/svelte/icons/history";
  import Save from "@lucide/svelte/icons/save";
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import LibraryTypeSwitch from "$lib/components/library/LibraryTypeSwitch.svelte";
  import AdvancedPanel from "$lib/components/library/agent-rules/AdvancedPanel.svelte";
  import CustomInstructions from "$lib/components/library/agent-rules/CustomInstructions.svelte";
  import EffectivePreviewDialog from "$lib/components/library/agent-rules/EffectivePreviewDialog.svelte";
  import HandWritten from "$lib/components/library/agent-rules/HandWritten.svelte";
  import HistorySheet from "$lib/components/library/agent-rules/HistorySheet.svelte";
  import LivePreview from "$lib/components/library/agent-rules/LivePreview.svelte";
  import ModulePicker from "$lib/components/library/agent-rules/ModulePicker.svelte";
  import PostureSection from "$lib/components/library/agent-rules/PostureSection.svelte";
  import VersionDialog from "$lib/components/library/agent-rules/VersionDialog.svelte";
  import { RulesDocState } from "$lib/components/library/agent-rules/rules-doc.svelte";
  import { RulesHistoryState } from "$lib/components/library/agent-rules/rules-history.svelte";
  import { RulesPostureState } from "$lib/components/library/agent-rules/rules-posture.svelte";
  import { RulesPreviewState } from "$lib/components/library/agent-rules/rules-preview.svelte";

  const doc = new RulesDocState();
  const posture = new RulesPostureState();
  const history = new RulesHistoryState(doc);
  const preview = new RulesPreviewState(doc, posture);

  let historyOpen = $state(false);
  const data = $derived(doc.data);
</script>

<PageShell
  title="Agent rules"
  description="The instructions every agent in the fleet starts from (fleet instructions, served as AGENTS.md or CLAUDE.md). Per-host guidance is added when it is served."
  width="wide"
>
  {#snippet actions()}
    <Button variant="outline" onclick={() => (preview.renderedPreviewOpen = true)} disabled={preview.hostsPending || preview.previewHosts.length === 0}>
      <Eye class="h-4 w-4" />
      Preview effective draft
    </Button>
    <Button variant="outline" onclick={() => (historyOpen = true)}>
      <History class="h-4 w-4" />
      History &amp; publishing
    </Button>
    <Button onclick={() => doc.save()} disabled={doc.saving || doc.composing || !doc.hydrated}>
      <Save class="h-4 w-4" />
      {doc.saving ? "Saving…" : "Save"}
    </Button>
  {/snippet}
  {#snippet subheader()}
    <LibraryTypeSwitch active="agent-rules" />
    {#if data}
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground">
        <span>Version <span class="font-mono text-foreground">#{history.currentVersionId ?? "—"}</span></span>
        <span aria-hidden="true">·</span>
        <Badge variant={data.mode === "locked" ? "warning" : "secondary"} title="Serve mode: which stored version hosts are handed">
          {data.mode === "locked" ? "locked version" : "serving latest"}
        </Badge>
        <span aria-hidden="true">·</span>
        <span>{formatBytes(data.size_bytes ?? 0)}</span>
        <span aria-hidden="true">·</span>
        <span>Updated {data.updated_at ? relativeTime(data.updated_at) : "—"}</span>
        {#if doc.serverSha}
          <span aria-hidden="true">·</span>
          <span class="font-mono" title={doc.serverSha}>sha256: {doc.serverSha.slice(0, 12)}…</span>
        {/if}
      </p>
    {/if}
  {/snippet}

  {#if doc.query.isError}
    <StateBlock
      state="error"
      message={doc.query.error instanceof Error ? doc.query.error.message : "Failed to load AGENTS.md"}
      onRetry={() => void doc.query.refetch()}
    />
  {:else if doc.query.isLoading || !doc.hydrated}
    <StateBlock state="loading" rows={6} />
  {:else}
    <div class="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div class="min-w-0 space-y-6">
        {#if doc.builderMode}
          <ModulePicker {doc} {preview} />
          <PostureSection {posture} {preview} />
          <CustomInstructions {doc} {preview} />
        {:else}
          <HandWritten {doc} {preview} />
        {/if}
        <AdvancedPanel {doc} />
      </div>
      <div class="min-w-0 xl:sticky xl:top-20 xl:self-start">
        <LivePreview {doc} {preview} />
      </div>
    </div>
  {/if}
</PageShell>

<HistorySheet bind:open={historyOpen} {history} />
<VersionDialog {history} />
<EffectivePreviewDialog {preview} />
