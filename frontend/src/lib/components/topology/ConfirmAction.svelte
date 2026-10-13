<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Textarea } from "$lib/components/ui/textarea";
  import LoaderIcon from "@lucide/svelte/icons/loader-circle";
  import CheckIcon from "@lucide/svelte/icons/circle-check";
  import AlertIcon from "@lucide/svelte/icons/triangle-alert";

  import type { ActionPhase as Phase } from "$lib/topology/model";
  type Props = {
    open: boolean;
    title: string;
    description: string;
    /** Who exactly is being acted on: label / value pairs. */
    target: Array<{ label: string; value: string }>;
    /** Who else is affected, listed by name. */
    affected?: { heading: string; items: string[]; empty: string };
    /** What will and will not happen, in plain words. */
    effects: string[];
    confirmLabel: string;
    pendingLabel: string;
    tone?: "destructive" | "default";
    phase: Phase;
    /** Shown in the done and error phases. */
    resultTitle?: string;
    /** `warning` for an outcome that is not the one that was asked for. */
    resultTone?: "success" | "warning";
    errorMessage?: string;
    /** Offer a free-text note that goes into the audit record. */
    withNote?: boolean;
    note?: string;
    onconfirm: () => void;
    onclose: () => void;
    /** Live follow-up under the result, e.g. "reconnected as …". */
    result?: Snippet;
  };
  let {
    open = $bindable(),
    title,
    description,
    target,
    affected,
    effects,
    confirmLabel,
    pendingLabel,
    tone = "destructive",
    phase,
    resultTitle = "Done",
    resultTone = "success",
    errorMessage = "",
    withNote = false,
    note = $bindable(""),
    onconfirm,
    onclose,
    result,
  }: Props = $props();
</script>

<Dialog.Root bind:open onOpenChange={(value) => { if (!value) onclose(); }}>
  <Dialog.Content class="sm:max-w-lg" aria-busy={phase === "pending"}>
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>

    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
      {#each target as row (row.label)}
        <dt class="text-muted-foreground">{row.label}</dt>
        <dd class="min-w-0 break-words font-medium">{row.value}</dd>
      {/each}
    </dl>

    {#if affected}
      <div>
        <p class="section-label mb-1.5">{affected.heading}</p>
        {#if affected.items.length === 0}
          <p class="text-sm text-muted-foreground">{affected.empty}</p>
        {:else}
          <ul class="max-h-32 space-y-0.5 overflow-y-auto text-sm">
            {#each affected.items as item (item)}<li class="truncate">• {item}</li>{/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if phase === "confirm" || phase === "pending"}
      <ul class="space-y-1 text-sm text-muted-foreground">
        {#each effects as effect (effect)}<li>• {effect}</li>{/each}
      </ul>
      {#if withNote}
        <label class="block text-sm">
          <span class="mb-1 block text-muted-foreground">Note for the audit record (optional)</span>
          <Textarea bind:value={note} rows={2} maxlength={500} disabled={phase === "pending"} />
        </label>
      {/if}
    {/if}

    <div aria-live="polite" class="min-h-0">
      {#if phase === "pending"}
        <p class="flex items-center gap-2 text-sm text-muted-foreground"><LoaderIcon class="h-4 w-4 animate-spin motion-reduce:animate-none" /> {pendingLabel}</p>
      {:else if phase === "done"}
        <div class="rounded-md border p-3 text-sm {resultTone === 'warning' ? 'border-warning/30 bg-warning-muted text-warning-muted-foreground' : 'border-success/30 bg-success-muted text-success-muted-foreground'}">
          <p class="flex items-center gap-2 font-medium">{#if resultTone === "warning"}<AlertIcon class="h-4 w-4" />{:else}<CheckIcon class="h-4 w-4" />{/if} {resultTitle}</p>
          {@render result?.()}
        </div>
      {:else if phase === "error"}
        <div role="alert" class="rounded-md border border-destructive/30 bg-destructive-muted p-3 text-sm text-destructive-muted-foreground">
          <p class="flex items-center gap-2 font-medium"><AlertIcon class="h-4 w-4" /> {errorMessage || "The action failed."}</p>
          <p class="mt-1">Nothing is assumed: check the live view before trying again.</p>
        </div>
      {/if}
    </div>

    <Dialog.Footer>
      {#if phase === "done"}
        <Button onclick={onclose}>Close</Button>
      {:else}
        <Button variant="ghost" onclick={onclose} disabled={phase === "pending"}>{phase === "error" ? "Close" : "Cancel"}</Button>
        <Button variant={tone === "destructive" ? "destructive" : "default"} onclick={onconfirm} disabled={phase === "pending"}>
          {phase === "pending" ? pendingLabel : phase === "error" ? "Try again" : confirmLabel}
        </Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
