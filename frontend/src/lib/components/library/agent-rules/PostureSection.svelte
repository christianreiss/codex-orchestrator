<script lang="ts">
  /** Security level and response verbosity: each saved on its own, apart from the document. */
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { Button } from "$lib/components/ui/button";
  import ResponseVerbosityPanel from "$lib/components/settings/ResponseVerbosityPanel.svelte";
  import SecurityLevelsPanel from "$lib/components/settings/SecurityLevelsPanel.svelte";
  import type { SecurityLevels } from "$lib/api/agentPolicyProfiles";
  import type { RulesPostureState } from "./rules-posture.svelte";
  import type { RulesPreviewState } from "./rules-preview.svelte";

  let { posture, preview }: { posture: RulesPostureState; preview: RulesPreviewState } = $props();
</script>

<DraftGuard dirty={posture.levelsDirty || posture.verbosityDirty} />
<section aria-labelledby="rules-posture-title" class="space-y-3">
  <div>
    <h2 id="rules-posture-title" class="text-h3">How cautious agents are</h2>
    <p class="text-body-sm text-muted-foreground">Security level and response length. Both apply fleet-wide and are saved separately from the document.</p>
  </div>

  <SecurityLevelsPanel
    catalog={posture.securityCatalog}
    levels={posture.draftLevels ?? posture.securityCatalog?.default_levels ?? ({} as SecurityLevels)}
    disabled={!posture.defaultProfile || posture.savingLevels}
    onChange={(next) => (posture.draftLevels = next)}
    blockCount={preview.activePreviewMode === "effective" ? preview.axisBlockCount : undefined}
    highlightedAxes={preview.highlightedAxes}
    onHighlight={(axisId) => preview.setActive(axisId === null ? null : { kind: "axis", id: axisId })}
  />
  {#if posture.rootClampWarning}
    <div class="rounded-md border border-warning/40 bg-warning-muted px-3 py-2">
      <p class="text-body-sm font-medium text-warning-muted-foreground">Bypass permissions cannot reach every host</p>
      <p class="mt-1 text-body-sm text-muted-foreground">{posture.rootClampWarning}</p>
    </div>
  {/if}
  {#if posture.levelsDirty}
    <div class="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
      <p class="text-body-sm text-muted-foreground">Posture is saved separately from the document.</p>
      <Button size="sm" onclick={() => posture.saveLevels()} disabled={posture.savingLevels}>{posture.savingLevels ? "Saving…" : "Save posture"}</Button>
    </div>
  {/if}

  <ResponseVerbosityPanel
    level={posture.draftVerbosity}
    levels={posture.verbosityLevelOptions}
    disabled={posture.savedVerbosity === null || posture.savingVerbosity}
    onChange={(next) => (posture.draftVerbosity = next)}
  />
  {#if posture.verbosityDirty}
    <div class="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
      <p class="text-body-sm text-muted-foreground">Verbosity is fleet-wide and saved separately from the document.</p>
      <Button size="sm" onclick={() => posture.saveVerbosity()} disabled={posture.savingVerbosity}>{posture.savingVerbosity ? "Saving…" : "Save verbosity"}</Button>
    </div>
  {/if}
</section>
