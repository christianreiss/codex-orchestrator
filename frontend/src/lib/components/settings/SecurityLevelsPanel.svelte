<script lang="ts">
  /**
   * Fleet security posture: a preset row plus one slider per risk axis.
   *
   * Two things this panel must never do, because both amount to lying to the
   * operator about what they just set:
   *
   *  - imply an axis is mechanically enforced when it is not (`prose only`), and
   *  - show a derived engine value without saying which axis is holding it down.
   *
   * The derived column therefore always names its governing axis, and marks a
   * step `prose only` where the neighbouring level produces the same config.
   */
  import { Badge } from "$lib/components/ui/badge";
  import { Label } from "$lib/components/ui/label";
  import { Slider } from "$lib/components/ui/slider";
  import * as Card from "$lib/components/ui/card";
  import {
    axesModifiedFrom,
    matchingPreset,
    type SecurityAxisId,
    type SecurityLevelCatalog,
    type SecurityLevels,
  } from "$lib/api/agentPolicyProfiles";

  type Props = {
    catalog: SecurityLevelCatalog | null;
    levels: SecurityLevels;
    disabled?: boolean;
    onChange: (levels: SecurityLevels) => void;
    /**
     * How many blocks of the previewed document an axis currently reaches.
     * Omitted when nothing is previewing the served policy text, in which case
     * the row says nothing rather than implying a link it cannot show.
     */
    blockCount?: (axisId: SecurityAxisId) => number;
    /** Axes feeding the block currently under the pointer in the preview. */
    highlightedAxes?: string[];
    /** Fires with the axis the operator is pointing at, or null on leave. */
    onHighlight?: (axisId: SecurityAxisId | null) => void;
  };

  let {
    catalog,
    levels,
    disabled = false,
    onChange,
    blockCount,
    highlightedAxes = [],
    onHighlight,
  }: Props = $props();

  // `?? []` so an older server whose catalog predates this panel renders empty
  // rather than throwing on a page the operator needs to reach.
  const axes = $derived(catalog?.axes ?? []);
  const presets = $derived(catalog?.presets ?? []);

  const activePreset = $derived(matchingPreset(presets, levels));
  const nearest = $derived(
    activePreset ??
      [...presets]
        .map((p) => ({ p, drift: axesModifiedFrom(p, levels).length }))
        .sort((a, b) => a.drift - b.drift)[0]?.p ??
      null,
  );
  const modifiedCount = $derived(nearest && !activePreset ? axesModifiedFrom(nearest, levels).length : 0);

  function setAxis(id: SecurityAxisId, value: number): void {
    onChange({ ...levels, [id]: value });
  }

  function applyPreset(id: string): void {
    const preset = presets.find((p) => p.id === id);
    if (preset) onChange({ ...preset.levels });
  }

  const enforcementLabel: Record<string, string> = {
    mechanical: "enforced",
    partial: "partly enforced",
    prose_only: "prose only",
  };
</script>

<Card.Root>
  <Card.Content class="space-y-5 p-4">
    <div class="space-y-1">
      <h3 class="text-sm font-semibold">Fleet security posture</h3>
      <p class="text-xs text-muted-foreground">
        Every axis runs the same direction: <span class="font-medium">0 is most constrained, 4 is
        unrestricted</span>. Levels change the served policy text, and drive engine config where a
        real knob exists.
      </p>
    </div>

    {#if axes.length === 0}
      <p class="text-xs text-muted-foreground">
        This server does not publish a security-level catalog yet.
      </p>
    {:else}
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          {#each presets as preset (preset.id)}
            <button
              type="button"
              {disabled}
              onclick={() => applyPreset(preset.id)}
              title={preset.description}
              class="rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 {activePreset?.id ===
              preset.id
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'border-border text-muted-foreground'}"
            >
              {preset.label}
            </button>
          {/each}
          {#if modifiedCount > 0 && nearest}
            <span class="text-xs text-muted-foreground">
              — {nearest.label}, modified: {modifiedCount}
              {modifiedCount === 1 ? "axis" : "axes"}
            </span>
          {/if}
        </div>
      </div>

      <div class="divide-y border-y border-border">
        {#each axes as axis (axis.id)}
          {@const level = levels[axis.id] ?? 0}
          {@const blocks = blockCount?.(axis.id) ?? 0}
          <!-- Hover and focus sit on the row, not the slider: the label and the
               description are the larger target, and focus parity comes free. -->
          <div
            role="group"
            aria-label={axis.label}
            class="grid gap-2 rounded-md py-3 transition-colors sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)] sm:items-center sm:gap-4 {highlightedAxes.includes(
              axis.id,
            )
              ? 'ring-2 ring-primary/50'
              : ''}"
            onmouseenter={() => onHighlight?.(axis.id)}
            onmouseleave={() => onHighlight?.(null)}
            onfocusin={() => onHighlight?.(axis.id)}
            onfocusout={() => onHighlight?.(null)}
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5">
                <Label for={`axis-${axis.id}`} class="text-sm font-medium">{axis.label}</Label>
                {#if axis.enforcement === "prose_only"}
                  <Badge variant="secondary" class="text-[10px]">prose only</Badge>
                {:else}
                  <Badge variant="secondary" class="text-[10px]">
                    {enforcementLabel[axis.enforcement]}
                  </Badge>
                {/if}
              </div>
              <p class="mt-0.5 text-xs text-muted-foreground">{axis.description}</p>
              {#if blockCount && blocks > 0}
                <!-- "Contributes to", never "produces": one bullet is routinely the
                     joint work of several axes, and this count cannot say otherwise. -->
                <p class="mt-0.5 text-xs text-muted-foreground/80">
                  contributes to {blocks} {blocks === 1 ? "block" : "blocks"}
                </p>
              {/if}
            </div>
            <div class="space-y-1">
              <Slider
                id={`axis-${axis.id}`}
                value={level}
                max={4}
                {disabled}
                aria-label={`${axis.label} level`}
                onValueChange={(value) => setAxis(axis.id, value)}
              />
              <p class="text-xs">
                <span class="font-mono text-muted-foreground">{level}</span>
                <span class="ml-1.5 text-foreground">{axis.bands[level] ?? ""}</span>
              </p>
            </div>
          </div>
        {/each}
      </div>

      <p class="text-xs text-muted-foreground">
        Lowering a level applies on a host's next launch, not immediately — a host holding a session
        lock keeps its current policy for that session.
      </p>
    {/if}
  </Card.Content>
</Card.Root>
