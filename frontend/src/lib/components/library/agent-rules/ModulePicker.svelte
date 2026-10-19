<script lang="ts">
  /**
   * What goes into the document: the guarantees that are always included
   * (read-only) and the optional operating modules (toggles). Hovering or
   * focusing a module lights up the text it produces in the live preview.
   */
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { cn } from "$lib/utils/cn";
  import type { AgentPolicyModuleId } from "$lib/api/types";
  import type { RulesDocState } from "./rules-doc.svelte";
  import type { RulesPreviewState } from "./rules-preview.svelte";

  let { doc, preview }: { doc: RulesDocState; preview: RulesPreviewState } = $props();

  const catalog = $derived(doc.data?.builder_catalog);
  const off = $derived(doc.generationMode === "off");
</script>

<section aria-labelledby="rules-modules-title" class="space-y-3">
  <div>
    <h2 id="rules-modules-title" class="text-h3">What goes in</h2>
    <p class="text-body-sm text-muted-foreground">
      {#if off}
        Modules are not served while generation is disabled. Your selection is kept and returns when you switch back to Generated.
      {:else}
        Changes stay in this draft until you save a new version.
      {/if}
    </p>
  </div>

  {#if !doc.documentIsBuilt}
    <p class="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-body-sm text-muted-foreground">
      The served version was hand-written, so this is an unsaved draft: every default module is on and the previous document is in
      Custom instructions. Nothing changes for hosts until you save.
    </p>
  {/if}

  <div class="divide-y rounded-md border">
    <p class="px-3 py-2 text-caption font-semibold text-muted-foreground">Always included</p>
    {#each catalog?.required ?? [] as item (item.id)}
      <div class="flex items-center justify-between gap-3 px-3 py-2">
        <div class="min-w-0">
          <Label for={`agents-required-${item.id}`} class="text-body font-medium">{item.label}</Label>
          <p class="text-body-sm text-muted-foreground">{item.description}</p>
        </div>
        <Switch id={`agents-required-${item.id}`} checked disabled aria-label={`${item.label} (required)`} />
      </div>
    {/each}
  </div>

  <div class={cn("divide-y rounded-md border", off && "opacity-60")}>
    <p class="px-3 py-2 text-caption font-semibold text-muted-foreground">Optional modules</p>
    {#each catalog?.modules ?? [] as item (item.id)}
      <!-- Hover and focus are wired on the row, not the Switch, so the label and
           description are part of the target and keyboard users get the same link. -->
      <div
        role="group"
        aria-label={item.label}
        class={cn("flex items-center justify-between gap-3 px-3 py-2 transition-colors", preview.linkClass(`module:${item.id}`))}
        onmouseenter={() => preview.setActive({ kind: "module", id: item.id })}
        onmouseleave={preview.clearActiveSetting}
        onfocusin={() => preview.setActive({ kind: "module", id: item.id })}
        onfocusout={preview.clearActiveSetting}
      >
        <div class="min-w-0">
          <Label for={`agents-module-${item.id}`} class="text-body font-medium">{item.label}</Label>
          <p class="text-body-sm text-muted-foreground">{item.description}</p>
        </div>
        <Switch
          id={`agents-module-${item.id}`}
          checked={doc.enabledModules.includes(item.id as AgentPolicyModuleId)}
          disabled={off}
          onCheckedChange={(value) => doc.setModule(item.id, Boolean(value))}
          aria-label={item.label}
        />
      </div>
    {/each}
  </div>
</section>
