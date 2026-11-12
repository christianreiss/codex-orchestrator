<script lang="ts" generics="T extends { enabled: boolean }">
  /**
   * One fleet on/off switch whose save can be ambiguous (the response is lost
   * after the server applied it). A failed save never leaves the control guessing:
   * it re-reads the server, reports "already applied" when the read confirms the
   * request, and otherwise offers one "Check state and retry". Shared by agent
   * coordination and the agent supervisor.
   */
  import { untrack, type Snippet } from "svelte";
  import { hasFocus, restoreFocus } from "$lib/utils/restore-focus";
  import { createMutation, useQueryClient, type CreateQueryResult } from "@tanstack/svelte-query";
  import { authStore } from "$lib/stores/auth";
  import type { Capability } from "$lib/auth/capabilities";
  import { Section, SaveState, StateBlock } from "$lib/components/page";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";

  type Props = {
    id: string;
    title: string;
    description: string;
    toggleLabel: string;
    help: string;
    /** Lower-case noun for messages, e.g. "agent coordination". */
    subject: string;
    readPermission: Capability;
    managePermission: Capability;
    queryKey: readonly unknown[];
    useQuery: () => CreateQueryResult<T, Error>;
    write: (enabled: boolean) => Promise<T>;
    /** Extra lines after "Effective state"; receives the confirmed value. */
    extra?: Snippet<[T]>;
    /** Plain sentence under the switch: what turning it off does. */
    footnote: string;
    /** Called once a requested state is confirmed, e.g. to refresh dependent views. */
    onConfirmed?: () => void;
  };
  let { id, title, description, toggleLabel, help, subject, readPermission, managePermission, queryKey, useQuery, write, extra, footnote, onConfirmed }: Props = $props();

  const query = untrack(() => useQuery());
  const client = useQueryClient();
  const canRead = $derived($authStore.can(readPermission));
  const canManage = $derived($authStore.can(managePermission));
  let attempted = $state<boolean | null>(null);
  let saveError = $state<unknown>(null);
  let checking = $state(false);
  let saved = $state(false);
  let recovered = $state(false);
  const mutation = createMutation<T, Error, boolean>({ mutationFn: (enabled) => untrack(() => write)(enabled), retry: false });
  const pending = $derived($mutation.isPending || checking);

  function confirm() {
    attempted = null; saveError = null; saved = true;
    onConfirmed?.();
  }
  async function reconcile(retry = false) {
    checking = true;
    try {
      const result = await $query.refetch({ throwOnError: true });
      if (attempted !== null && result.data?.enabled === attempted) {
        recovered = true; confirm();
      } else if (retry && attempted !== null && canManage) {
        const enabled = attempted;
        checking = false;
        await save(enabled);
      }
    } catch {
      // Keep the original save error and requested value until a read confirms state.
    } finally { checking = false; }
  }
  async function save(enabled: boolean) {
    if (!canManage || pending) return;
    // The switch is re-created when the confirmed state changes; give it back its keyboard focus.
    const refocus = hasFocus(`${id}-toggle`);
    attempted = enabled; saveError = null; saved = false; recovered = false;
    await client.cancelQueries({ queryKey: [...queryKey] });
    try {
      const next = await $mutation.mutateAsync(enabled);
      client.setQueryData([...queryKey], next);
      if (next.enabled !== enabled) throw new Error(`The server returned a different ${subject} setting.`);
      confirm();
    } catch (error) {
      saveError = error;
      await reconcile();
    } finally {
      if (refocus) await restoreFocus(`${id}-toggle`);
    }
  }
</script>

<Section {id} {title} {description}>
  {#if !canRead}
    <p class="text-body-sm text-muted-foreground">Viewing this setting requires <code class="font-mono">{readPermission}</code>. Ask an administrator for access.</p>
  {:else if $query.isPending}
    <StateBlock state="loading" rows={2} />
  {:else}
    {#if $query.isError}
      <StateBlock state="error" cause={$query.error} message={$query.data ? `Could not refresh ${subject}. The displayed state is stale.` : `Could not load ${subject}.`} onRetry={() => void reconcile()} />
    {/if}
    {#if $query.data}
      <div class="flex items-start justify-between gap-4 border-y py-3">
        <div class="min-w-0 space-y-1">
          <label for={`${id}-toggle`} class="text-body font-medium">{toggleLabel}</label>
          <p id={`${id}-help`} class="text-body-sm text-muted-foreground">{help}</p>
          <p class="text-body-sm">{$query.isError ? "Last confirmed state" : "Effective state"}: <strong>{$query.data.enabled ? "Enabled" : "Disabled"}</strong></p>
          {@render extra?.($query.data)}
        </div>
        {#key `${$mutation.status}:${$query.data.enabled}`}
          <Switch id={`${id}-toggle`} checked={$query.data.enabled} disabled={!canManage || pending || $query.isError || $query.isFetching || attempted !== null} aria-describedby={`${id}-help ${id}-status`} onCheckedChange={(enabled) => void save(enabled)} />
        {/key}
      </div>
    {/if}
    <div id={`${id}-status`} class="mt-2 space-y-2">
      <p class="text-body-sm text-muted-foreground">Changes save immediately. {footnote}</p>
      {#if !canManage}<p class="text-body-sm text-muted-foreground">Read only. Changes require <code class="font-mono">{managePermission}</code>.</p>{/if}
      {#if pending}<p role="status" class="text-body-sm text-muted-foreground">{checking ? "Checking the current server state…" : "Saving… Waiting for server confirmation."}</p>
      {:else if saveError}
        <SaveState error={saveError} />
        <p class="text-body-sm">Requested state: {attempted ? "Enabled" : "Disabled"}. {$query.isError ? "Current server state is unconfirmed." : "The current server state is shown above."}</p>
        <Button variant="outline" size="sm" onclick={() => void reconcile(canManage)}>{canManage ? "Check state and retry" : "Check current state"}</Button>
      {:else if saved}<SaveState saved />
        {#if recovered}<p class="text-body-sm text-muted-foreground">The save response failed, but a fresh server read confirmed the requested state. No repeat write was needed.</p>{/if}
      {:else if $query.isFetching}<p role="status" class="text-body-sm text-muted-foreground">Refreshing current state…</p>{/if}
    </div>
  {/if}
</Section>
