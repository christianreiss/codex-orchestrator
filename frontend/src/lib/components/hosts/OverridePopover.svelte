<script module lang="ts">
  let instances = 0;
</script>

<script lang="ts">
  /**
   * A labeled row showing an effective value plus where it came from (host
   * override vs fleet default), with an inline popover editor — the
   * "effective value + source" interaction rule, and the inline-popover
   * replacement for what used to be a full modal per field.
   */
  import { toStore } from 'svelte/store';
  import { modelPolicyQuery } from '$lib/api/model-policy';
  import { filterModelOptions, modelOptionsEngine } from '$lib/components/ui/model-select/policy';
  import * as Popover from "$lib/components/ui/popover";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Select from "$lib/components/ui/select";
  import { Label } from "$lib/components/ui/label";
  import Pencil from "@lucide/svelte/icons/pencil";

  type Option = { value: string; label: string; disabled?: boolean };
  type Props = {
    label: string;
    /** Current host-level override, or null/undefined when inheriting. */
    override: string | null | undefined;
    /**
     * The value in effect when there is no override, if known (e.g. the
     * host's own detected version). Left undefined when nothing more
     * specific than "some fleet default" is known — the row then reads
     * "No override set" rather than fabricating a value.
     */
    inheritedValue?: string | null;
    /** Word used for the "no override" source, e.g. "detected" vs "fleet default". */
    inheritedLabel?: string;
    placeholder?: string;
    /** When set, renders a Select instead of a free-text Input. */
    options?: Option[];
    pending?: boolean;
    onSave: (value: string | null) => Promise<void>;
  };
  let {
    label,
    override,
    inheritedValue,
    inheritedLabel = "fleet default",
    placeholder,
    options,
    pending = false,
    onSave,
  }: Props = $props();

  const policy = modelPolicyQuery(toStore(() => modelOptionsEngine(options ?? [])));
  const visibleOptions = $derived(filterModelOptions(options ?? [], $policy.data));
  const successor = $derived($policy.data?.latest_only && override ? $policy.data.replacements[override] : undefined);

  const fieldId = `override-popover-${++instances}`;

  let open = $state(false);
  let draft = $state("");
  let busy = $state(false);
  let error = $state("");

  $effect(() => {
    if (open) { draft = override ?? ""; error = ""; }
  });

  async function save(): Promise<void> {
    busy = true;
    error = "";
    try {
      await onSave(draft.trim() === "" ? null : draft.trim());
      open = false;
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not save override";
    } finally {
      busy = false;
    }
  }

  async function clearOverride(): Promise<void> {
    busy = true;
    error = "";
    try {
      await onSave(null);
      open = false;
    } catch (err) {
      error = err instanceof Error ? err.message : "Could not save override";
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0">
  <div class="min-w-0">
    <div class="text-body">{label}</div>
    <div class="truncate font-mono text-caption text-muted-foreground">
      {#if override}
        {override}{#if successor && successor !== override} → {successor}{/if} <span class="font-sans">· set for this host</span>
      {:else if inheritedValue}
        {inheritedValue} <span class="font-sans">· {inheritedLabel}</span>
      {:else}
        <span class="font-sans">No override set</span>
      {/if}
    </div>
  </div>
  <Popover.Root bind:open>
    <Popover.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="outline" size="sm" disabled={pending}>
          <Pencil class="h-3.5 w-3.5" />
          Edit
        </Button>
      {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-72 space-y-3" align="end">
      <div class="space-y-1.5">
        <Label for={fieldId}>{label}</Label>
        {#if options}
          <Select.Root
            type="single"
            value={draft}
            onValueChange={(v) => (draft = v ?? "")}
          >
            <Select.Trigger id={fieldId}>
              {options.find((o) => o.value === draft)?.label ?? `Inherit (${inheritedLabel})`}
            </Select.Trigger>
            <Select.Content>
              {#each visibleOptions as o (o.value)}
                <Select.Item value={o.value} label={o.label} disabled={o.disabled} aria-disabled={o.disabled ? true : undefined} />
              {/each}
            </Select.Content>
          </Select.Root>
        {:else}
          <Input
            id={fieldId}
            bind:value={draft}
            placeholder={placeholder ?? inheritedValue ?? ""}
            autocomplete="off"
          />
        {/if}
      </div>
      {#if error}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}
      <div class="flex justify-end gap-2">
        {#if override}
          <Button variant="ghost" size="sm" onclick={clearOverride} disabled={busy}>
            Clear
          </Button>
        {/if}
        <Button size="sm" onclick={save} disabled={busy || options?.find(option => option.value === draft)?.disabled}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </Popover.Content>
  </Popover.Root>
</div>
