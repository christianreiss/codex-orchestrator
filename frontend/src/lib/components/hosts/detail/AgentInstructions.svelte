<script lang="ts">
  /**
   * Optional per-host agent instructions, appended to the fleet AGENTS.md /
   * CLAUDE.md this host receives. Explicit save: the text is prose, and a
   * half-typed sentence must never reach a host.
   */
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { DraftGuard, SaveState, Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { FormField } from "$lib/components/ui/form-field";
  import { Textarea } from "$lib/components/ui/textarea";
  import { createHostAgentsExtraMutation, hostAgentsExtraQuery } from "$lib/api/hosts";
  import { authStore } from "$lib/stores/auth";

  type Props = { id: string; fqdn: string };
  let { id, fqdn }: Props = $props();

  const qc = useQueryClient();
  const query = $derived(hostAgentsExtraQuery(id));
  const save = createHostAgentsExtraMutation(qc);

  let draft = $state("");
  let baseline = $state<string | null>(null);
  let seededFor: string | null = null;
  const dirty = $derived(baseline !== null && draft !== baseline);
  const stored = $derived($query.data?.content ?? "");
  // Changed elsewhere (another tab, another admin) while this draft was open.
  const conflict = $derived(dirty && $query.isSuccess && stored !== baseline);
  const maxBytes = $derived($query.data?.max_bytes ?? 32768);
  const bytes = $derived(new TextEncoder().encode(draft.trim()).length);
  const tooLong = $derived(bytes > maxBytes);
  const canManage = $derived($authStore.can("hosts.manage"));
  const busy = $derived($save.isPending);
  let confirmClear = $state(false);

  function adopt(content: string | null) {
    draft = content ?? "";
    baseline = content ?? "";
  }
  $effect(() => {
    const data = $query.data;
    if (!data) return;
    untrack(() => {
      if (seededFor !== id || !dirty) {
        seededFor = id;
        adopt(data.content);
      }
    });
  });

  async function submit(content: string | null): Promise<boolean> {
    if (!canManage || busy || (content !== null && tooLong)) return false;
    try {
      adopt((await $save.mutateAsync({ id, content })).content);
      return true;
    } catch {
      // SaveState (and the dialog, for Clear) shows the failure; the draft stays.
      return false;
    }
  }
  async function clear() {
    if (await submit(null)) confirmClear = false;
  }
  function reset() {
    adopt($query.data?.content ?? null);
    $save.reset();
  }
  const hint = $derived(
    `${bytes.toLocaleString()} of ${maxBytes.toLocaleString()} bytes. Appended to the fleet AGENTS.md / CLAUDE.md for this host only, on its next sync.`,
  );
</script>

<DraftGuard {dirty} />
<Section
  title="Agent instructions"
  description="Extra rules for agents on this host. They are added after the fleet policy for every engine."
>
  {#if $query.isPending}
    <p role="status" class="text-body-sm text-muted-foreground">Loading agent instructions…</p>
  {:else if $query.isError}
    <div role="alert" class="space-y-2 text-body-sm">
      <p class="text-destructive">Could not load agent instructions: {$query.error.message}</p>
      <Button variant="outline" size="sm" onclick={() => void $query.refetch()}>Retry loading</Button>
    </div>
  {:else}
    <form class="space-y-3" onsubmit={(event) => { event.preventDefault(); submit(draft); }}>
      <FormField
        id="host-agents-extra"
        label="Host-specific instructions"
        hint={tooLong ? undefined : hint}
        error={tooLong ? `Too long: ${bytes.toLocaleString()} of ${maxBytes.toLocaleString()} bytes. Shorten the text to save.` : undefined}
      >
        <Textarea
          id="host-agents-extra"
          bind:value={draft}
          rows={8}
          class="font-mono text-body-sm"
          placeholder="Optional. For example: Deploy only from the release branch on this host."
          disabled={!canManage || busy}
          aria-invalid={tooLong ? "true" : undefined}
          aria-describedby={tooLong ? "host-agents-extra-error" : "host-agents-extra-hint"}
          oninput={() => $save.reset()}
        />
      </FormField>
      {#if !canManage}
        <p class="text-body-sm text-muted-foreground">You can view these instructions. Changing them needs host management access.</p>
      {/if}
      {#if conflict}
        <p role="alert" class="rounded-md border border-warning/40 bg-warning/10 p-3 text-body-sm">
          These instructions changed elsewhere. Your draft is kept. Reset loads the current text.
        </p>
      {/if}
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" type="submit" disabled={!canManage || busy || !dirty || tooLong || conflict}>Save instructions</Button>
        <Button size="sm" variant="outline" type="button" onclick={reset} disabled={busy || !dirty}>Reset</Button>
        {#if stored}
          <Button size="sm" variant="ghost" type="button" disabled={!canManage || busy || dirty} onclick={() => (confirmClear = true)}>Clear instructions</Button>
        {/if}
      </div>
      <SaveState pending={busy} error={$save.error} {dirty} saved={$save.isSuccess} />
    </form>
  {/if}
</Section>

<ConfirmDialog
  bind:open={confirmClear}
  title="Clear agent instructions"
  description={`Agents on ${fqdn} will receive the fleet document without host-specific instructions on their next sync. The text is not kept.`}
  confirmLabel="Clear instructions"
  busyLabel="Clearing…"
  destructive
  {busy}
  error={confirmClear && $save.isError ? $save.error.message : null}
  onConfirm={clear}
  onClose={() => $save.reset()}
/>
