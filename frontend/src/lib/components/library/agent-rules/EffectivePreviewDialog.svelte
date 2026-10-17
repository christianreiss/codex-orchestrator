<script lang="ts">
  /**
   * Preview effective draft: the exact document a chosen host and engine would
   * receive if this draft were saved, with the state of every managed feature
   * block. Shares its host/engine choice and render query with the live preview.
   */
  import Eye from "@lucide/svelte/icons/eye";
  import { formatBytes } from "$lib/utils/format";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import RenderedMarkdown from "$lib/components/authoring/RenderedMarkdown.svelte";
  import type { RulesPreviewState } from "./rules-preview.svelte";

  let { preview }: { preview: RulesPreviewState } = $props();

  const engineLabel = (engine: string) => (engine === "codex" ? "Codex" : engine === "claude" ? "Claude" : "Grok");
  const query = $derived(preview.renderQuery);
  const rendered = $derived(preview.rendered);
</script>

<Dialog.Root bind:open={preview.renderedPreviewOpen}>
  <Dialog.Content class="sm:max-w-5xl">
    <Dialog.Header>
      <Dialog.Title>Effective AGENTS.md draft</Dialog.Title>
      <Dialog.Description>
        This is the exact document the selected host would receive if this draft were saved, including mandatory fleet policy and live
        managed feature guidance.
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-3">
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-60 flex-1 space-y-1.5">
          <Label for="agents-preview-host">Host</Label>
          <!-- The host is part of the query key, so switching it re-renders in place. -->
          <Select.Root type="single" value={preview.previewHostId} onValueChange={(value) => (preview.previewHostId = value ?? "")}>
            <Select.Trigger id="agents-preview-host" aria-label="Host for rendered AGENTS preview">
              <Select.Value placeholder="Choose a host">
                {preview.previewHosts.find((host) => String(host.id) === preview.previewHostId)?.fqdn ?? "Choose a host"}
              </Select.Value>
            </Select.Trigger>
            <Select.Content>
              {#each preview.previewHosts as host (host.id)}
                <Select.Item value={String(host.id)} label={host.fqdn}>{host.fqdn} · #{host.id}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="w-32 space-y-1.5">
          <Label for="agents-preview-engine">Engine</Label>
          <Select.Root type="single" value={preview.previewEngine} onValueChange={(value) => { if (value) preview.previewEngine = value as typeof preview.previewEngine; }}>
            <Select.Trigger id="agents-preview-engine">{engineLabel(preview.previewEngine)}</Select.Trigger>
            <Select.Content>
              {#each preview.previewHostEngines as engine (engine)}<Select.Item value={engine} label={engineLabel(engine)} />{/each}
            </Select.Content>
          </Select.Root>
        </div>
        <Button onclick={() => void query.refetch()} disabled={query.isFetching || !preview.previewHostId}>
          <Eye class="h-4 w-4" />
          {query.isFetching ? "Rendering…" : "Refresh"}
        </Button>
      </div>

      {#if query.isPending}
        <p class="text-body-sm text-muted-foreground">Rendering the host-specific document…</p>
      {:else if rendered?.status === "missing"}
        <p class="text-body-sm text-muted-foreground">No AGENTS.md document is currently configured for this host.</p>
      {:else if rendered}
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2 text-body-sm text-muted-foreground">
            <span class="font-medium text-foreground">{rendered.host_fqdn}</span>
            <span>·</span>
            <span>Version #{rendered.version_id ?? "—"}</span>
            <span>·</span>
            <span>{formatBytes(rendered.size_bytes ?? 0)}</span>
            {#if rendered.sha256}
              <span>·</span>
              <span class="font-mono" title={rendered.sha256}>sha256: {rendered.sha256.slice(0, 12)}…</span>
            {/if}
          </div>
          <CopyButton value={rendered.content ?? ""} label="Copy document" copiedLabel="Copied" size="sm" toastMessage="Rendered AGENTS.md copied" />
        </div>
        {#if preview.renderedSections.length > 0}
          <div class="flex flex-wrap gap-1.5" aria-label="Managed feature state">
            {#each preview.renderedSections as { name, section } (name)}
              <Badge variant={section.present ? "success" : "secondary"}>{name}: {section.present ? "included" : section.reason}</Badge>
            {/each}
          </div>
        {/if}
        <article aria-label="Effective AGENTS.md draft document">
          <RenderedMarkdown source={rendered.content ?? ""} ariaLabel="Rendered AGENTS.md content" class="min-h-[55vh] bg-background p-6 sm:p-8" />
        </article>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (preview.renderedPreviewOpen = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
