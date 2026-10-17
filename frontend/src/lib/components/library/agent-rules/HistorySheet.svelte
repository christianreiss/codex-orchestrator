<script lang="ts">
  /**
   * History & publishing: which stored version hosts are handed, how many
   * backups are kept, and the version list (click one to preview, then restore).
   * None of it changes the draft, so the live preview does not react to it.
   */
  import History from "@lucide/svelte/icons/history";
  import { relativeTime } from "$lib/utils/format";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import * as Sheet from "$lib/components/ui/sheet";
  import type { RulesHistoryState } from "./rules-history.svelte";

  let { open = $bindable(), history }: { open: boolean; history: RulesHistoryState } = $props();
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="flex w-full flex-col gap-4 sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title class="flex items-center gap-2"><History class="h-4 w-4" />History &amp; publishing</Sheet.Title>
      <Sheet.Description>Every save is kept as a version. These controls decide which one hosts get; they do not change the draft.</Sheet.Description>
    </Sheet.Header>

    <div class="min-h-0 flex-1 space-y-5 overflow-y-auto">
      <section class="space-y-2" aria-labelledby="rules-versions-title">
        <h3 id="rules-versions-title" class="text-h3">Version history</h3>
        <p class="text-body-sm text-muted-foreground">Click a version to preview it before restoring. There is no one-click restore.</p>
        {#if history.versions.length === 0}
          <p class="text-body-sm text-muted-foreground">No versions yet.</p>
        {:else}
          <ul class="divide-y rounded-md border">
            {#each history.versions as version (version.id)}
              <li>
                <button type="button" class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/50" disabled={history.loadingVersion} onclick={() => history.loadVersion(version.id)}>
                  <span class="min-w-0">
                    <span class="font-mono text-body-sm">#{version.id}</span>
                    <span class="ml-2 text-body-sm text-muted-foreground">{version.updated_at ? relativeTime(version.updated_at) : "—"}</span>
                  </span>
                  {#if version.is_served}
                    <Badge variant="success">served</Badge>
                  {:else if version.is_latest}
                    <Badge variant="secondary">latest</Badge>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="space-y-2" aria-labelledby="rules-serve-title">
        <h3 id="rules-serve-title" class="text-h3">Which version hosts get</h3>
        <p class="text-body-sm text-muted-foreground">
          <strong class="font-medium text-foreground">Latest</strong>: hosts always get the newest saved version.
          <strong class="font-medium text-foreground">Locked</strong>: hosts keep getting one chosen version, even if you save newer ones, until you switch back. (Serve mode.)
        </p>
        <Select.Root type="single" bind:value={history.serveMode as string}>
          <Select.Trigger aria-label="Serve mode">
            <span>{history.serveMode === "locked" ? "Locked at version" : "Latest"}</span>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="latest" label="Latest" />
            <Select.Item value="locked" label="Locked at version" />
          </Select.Content>
        </Select.Root>
        {#if history.serveMode === "locked"}
          <Input aria-label="Locked version ID" type="number" placeholder="Version ID" bind:value={history.serveLockedId} min={1} />
        {/if}
        <Button size="sm" onclick={() => history.applyServeMode()} disabled={history.serving}>Apply</Button>
      </section>

      <section class="space-y-2" aria-labelledby="rules-retention-title">
        <h3 id="rules-retention-title" class="text-h3">Retention</h3>
        <div class="flex items-end gap-2">
          <div class="flex-1 space-y-1.5">
            <Label for="retention-days">Backups to keep</Label>
            <Input id="retention-days" type="number" min={0} max={200} bind:value={history.retentionInput} />
          </div>
          <Button size="sm" variant="outline" onclick={() => history.saveRetention()} disabled={history.savingRetention}>Save</Button>
        </div>
        <p class="text-body-sm text-muted-foreground">Older versions beyond this count are pruned.</p>
      </section>
    </div>
  </Sheet.Content>
</Sheet.Root>
