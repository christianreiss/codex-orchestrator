<script lang="ts">
  /**
   * The fleet's model tiers as a board: five fixed levels, each registry model in the column of
   * its tier. Drag a model to another tier, or use its menu (the non-drag path for keyboard,
   * touch and screen readers; DESIGN.md ACC-1). Moves stay a draft until "Save tiers" (INT-3):
   * a move changes when agents stop as underclassed and which model the advisor treats as
   * strongest, fleet-wide. Each tier is a row; its models keep engine and registry order, so
   * a drop never suggests a position inside one.
   */
  import { untrack } from "svelte";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import MoreHorizontal from "@lucide/svelte/icons/more-horizontal";
  import { Section, StateBlock, DraftGuard, SaveState } from "$lib/components/page";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import HiddenEngineNote from "$lib/components/engines/HiddenEngineNote.svelte";
  import { modelTiersMutation, modelTiersQuery, type ModelTierModel } from "$lib/api/settings";
  import { authStore } from "$lib/stores/auth";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { ENGINE_META } from "$lib/constants/engines";
  import { cn } from "$lib/utils/cn";
  import { defaultsDraft, deviations, draftFrom, tierColumns, tierKey, tierPayload, unsavedMoves, type TierDraft } from "./model-tier-board";

  const query = modelTiersQuery();
  const fleet = useFleetEngines();
  const canManage = $derived($authStore.can("settings.manage"));

  let draft = $state<TierDraft>({});
  let saved = $state(false);
  const models = $derived($query.data?.models ?? []);
  const moves = $derived(unsavedMoves(models, draft));
  const dirty = $derived(moves > 0);

  // Adopt the server's placements, never over unsaved moves (and never read `draft` here).
  $effect(() => {
    const data = $query.data;
    if (!data || untrack(() => dirty)) return;
    draft = draftFrom(data.models);
  });

  const save = modelTiersMutation({
    onSuccess: (value) => { draft = draftFrom(value.models); saved = true; },
  });
  const columns = $derived(tierColumns($query.data?.levels ?? [], models, draft, (engine) => $fleet.isEnabled(engine)));
  const hidden = $derived(models.filter((model) => !$fleet.isEnabled(model.engine)).length);
  const placedAway = $derived(deviations(models, draft));

  /** A model's draft tier; one the draft has not seen yet (new from the server) keeps its saved tier. */
  const placedTier = (model: ModelTierModel) => draft[tierKey(model)] ?? model.tier;

  function move(key: string, tier: number) {
    const model = models.find((candidate) => tierKey(candidate) === key);
    if (!canManage || !model || placedTier(model) === tier) return;
    draft = { ...draft, [key]: tier };
    saved = false;
    $save.reset();
  }

  // Native drag and drop; the menu on every card does the same without a pointer.
  let dragging = $state<string | null>(null);
  let over = $state<number | null>(null);
  function dragStart(event: DragEvent, key: string) {
    dragging = key;
    event.dataTransfer?.setData("text/plain", key);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  function dragOver(event: DragEvent, tier: number) {
    if (!dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    over = tier;
  }
  function dragLeave(event: DragEvent, tier: number) {
    const next = event.relatedTarget;
    if (over === tier && !(next instanceof Node && (event.currentTarget as HTMLElement).contains(next))) over = null;
  }
  function drop(event: DragEvent, tier: number) {
    event.preventDefault();
    const key = event.dataTransfer?.getData("text/plain") || dragging;
    if (key) move(key, tier);
    dragging = null;
    over = null;
  }
  const engineName = (model: ModelTierModel) => ENGINE_META[model.engine].label;
</script>

<DraftGuard {dirty} preserveOnSamePath />

<Section
  id="model-tiers"
  title="Model tiers"
  description="Which tier each model counts as. Agents compare their model's tier with the task's (Model Class Check), pick models for delegated work by tier, and the Fleet Advisor uses the strongest one. Drag a model to another tier, or use its menu. The five levels and their rules stay fixed."
>
  {#if $query.isError && !$query.data}
    <StateBlock state="error" cause={$query.error} message={`Could not load the model tiers: ${$query.error.message}`} onRetry={() => $query.refetch()} />
  {:else if !$query.data}
    <StateBlock state="loading" />
  {:else}
    <div class="divide-y overflow-hidden rounded-md border" data-testid="tier-board">
      {#each columns as column (column.tier)}
        <section
          aria-labelledby={`tier-${column.tier}-title`}
          class={cn(
            "grid gap-2 p-3 transition-colors sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4",
            over === column.tier && "bg-primary/5 ring-2 ring-inset ring-primary/40",
          )}
          data-testid={`tier-column-${column.tier}`}
          ondragover={(event) => dragOver(event, column.tier)}
          ondragleave={(event) => dragLeave(event, column.tier)}
          ondrop={(event) => drop(event, column.tier)}
        >
          <header>
            <h3 id={`tier-${column.tier}-title`} class="font-medium">Tier {column.tier} <span class="font-normal text-muted-foreground">· {column.models.length} {column.models.length === 1 ? "model" : "models"}</span></h3>
            <p class="text-caption text-muted-foreground">{column.work}</p>
          </header>
          {#if column.models.length}
            <ul class="flex min-h-9 flex-wrap content-start gap-2">
              {#each column.models as model (tierKey(model))}
                {@const key = tierKey(model)}
                {@const tier = placedTier(model)}
                {@const unsaved = tier !== model.tier}
                <li
                  draggable={canManage}
                  ondragstart={(event) => dragStart(event, key)}
                  ondragend={() => { dragging = null; over = null; }}
                  class={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-md border bg-card py-1 pl-2 text-body-sm",
                    canManage ? "cursor-grab pr-0.5 active:cursor-grabbing" : "pr-2",
                    unsaved && "border-primary ring-1 ring-primary/40",
                    dragging === key && "opacity-50",
                  )}
                  data-testid="tier-model"
                  data-model={key}
                >
                  {#if canManage}<GripVertical class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />{/if}
                  <span class={cn("h-2 w-2 shrink-0 rounded-full", ENGINE_META[model.engine].color)} aria-hidden="true"></span>
                  <span class="min-w-0">
                    <span class="font-medium">{model.label}</span>
                    <span class="text-caption text-muted-foreground">{engineName(model)}</span>
                    {#if unsaved}
                      <span class="text-caption text-primary">· unsaved, was Tier {model.tier}</span>
                    {:else if tier !== model.default_tier}
                      <span class="text-caption text-muted-foreground">· default Tier {model.default_tier}</span>
                    {/if}
                  </span>
                  {#if model.status === "deprecated"}<Badge variant="secondary">Deprecated</Badge>{/if}
                  {#if canManage}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger>
                        {#snippet child({ props })}
                          <Button {...props} variant="ghost" size="icon" class="h-7 w-7 shrink-0" aria-label={`Move ${engineName(model)} ${model.label}`}>
                            <MoreHorizontal class="size-4" />
                          </Button>
                        {/snippet}
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end">
                        <!-- bits-ui throws when a Label has no Group around it. -->
                        <DropdownMenu.Group>
                          <DropdownMenu.Label>Move to</DropdownMenu.Label>
                          {#each columns as target (target.tier)}
                            {#if target.tier !== tier}
                              <DropdownMenu.Item onSelect={() => move(key, target.tier)}>Tier {target.tier}</DropdownMenu.Item>
                            {/if}
                          {/each}
                        </DropdownMenu.Group>
                        {#if tier !== model.default_tier}
                          <DropdownMenu.Separator />
                          <DropdownMenu.Item onSelect={() => move(key, model.default_tier)}>Reset to default (Tier {model.default_tier})</DropdownMenu.Item>
                        {/if}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class={cn("flex min-h-9 items-center text-caption text-muted-foreground", canManage && "rounded-md border border-dashed px-3")}>
              {canManage ? "No model in this tier. Drop one here." : "No model in this tier."}
            </p>
          {/if}
        </section>
      {/each}
    </div>
    <div class="mt-3 grid gap-2">
      <HiddenEngineNote count={hidden} />
      {#if canManage}
        <div class="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={!dirty || $save.isPending} onclick={() => { saved = false; $save.mutate(tierPayload(models, draft)); }}>Save tiers</Button>
          <Button size="sm" variant="outline" disabled={!dirty || $save.isPending} onclick={() => { draft = draftFrom(models); $save.reset(); }}>Discard changes</Button>
          <Button size="sm" variant="ghost" disabled={placedAway === 0 || $save.isPending} onclick={() => { draft = defaultsDraft(models); saved = false; $save.reset(); }}>Reset all to defaults</Button>
          <SaveState pending={$save.isPending} error={$save.error} {dirty} {saved} />
        </div>
        <p class="text-body-sm text-muted-foreground">Saved tiers reach agents at their next sync. No new document version is needed.</p>
      {:else}
        <p class="text-body-sm text-muted-foreground">Read-only: moving models between tiers requires the <code class="font-mono">settings.manage</code> capability.</p>
      {/if}
    </div>
  {/if}
</Section>
