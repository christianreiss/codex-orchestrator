<script lang="ts">
  /**
   * Provider keys: the real provider API keys a gateway API spends while its
   * source is API key. Not the gateway client keys under Access › API keys.
   * Built from `GET /admin/provider-keys` alone, which carries each provider's
   * surface, source and counts, so a viewer without `settings.read` sees it too.
   */
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { base } from "$app/paths";
  import Plus from "@lucide/svelte/icons/plus";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import HiddenEngineNote from "$lib/components/engines/HiddenEngineNote.svelte";
  import ProviderKeyTable from "$lib/components/provider-keys/ProviderKeyTable.svelte";
  import ProviderKeyDialog from "$lib/components/provider-keys/ProviderKeyDialog.svelte";
  import { failoverOrder, isUsable, keyErrorText, moveIds, removalConsequence, VERIFICATION } from "$lib/components/provider-keys/provider-key-model";
  import { providerKeysApi, providerKeysQuery, providerKeysQueryKey } from "$lib/api/provider-keys";
  import { apiSurfacesQueryKey } from "$lib/api/settings";
  import { ApiError } from "$lib/api/client";
  import { errorText } from "$lib/api/access-denied";
  import type { ProviderId, ProviderKey, ProviderKeyProvider, ProviderKeysValue } from "$lib/api/types";
  import { authStore } from "$lib/stores/auth";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { engineLabel } from "$lib/constants/engines";

  const qc = useQueryClient();
  const query = providerKeysQuery();
  const fleet = useFleetEngines();
  const canManage = $derived($authStore.can("keys.manage"));

  const data = $derived($query.data);
  // A switched-off engine is not part of the fleet (INT-1): its provider's keys are kept
  // server-side and only counted, like accounts.
  const providers = $derived((data?.providers ?? []).filter((p) => $fleet.isEnabled(p.engine)));
  const hidden = $derived((data?.keys ?? []).filter((k) => !providers.some((p) => p.provider === k.provider)).length);
  const keysOf = (provider: ProviderId) => failoverOrder((data?.keys ?? []).filter((k) => k.provider === provider));
  const providerOf = (provider: string) => data?.providers.find((p) => p.provider === provider) ?? null;

  let dialogOpen = $state(false);
  let editing = $state<ProviderKey | null>(null);
  let dialogProvider = $state<ProviderId | null>(null);
  let verifying = $state<Set<number>>(new Set());
  let busyProvider = $state<string | null>(null);
  let actionErrors = $state<Record<string, string | null>>({});
  let announcement = $state("");

  let deleteTarget = $state<ProviderKey | null>(null);
  let deleteOpen = $state(false);
  let deleteError = $state<string | null>(null);
  let pauseTarget = $state<ProviderKey | null>(null);
  let pauseOpen = $state(false);
  let pauseError = $state<string | null>(null);

  const deleteConsequence = $derived(deleteTarget ? consequence(deleteTarget) : null);
  const pauseConsequence = $derived(pauseTarget ? consequence(pauseTarget) : null);

  function consequence(key: ProviderKey) {
    const provider = providerOf(key.provider);
    return removalConsequence(key, keysOf(key.provider), {
      label: provider?.label ?? key.provider,
      base_path: provider?.base_path ?? null,
      source: provider?.source ?? "emulated",
    });
  }

  function describe(err: unknown, provider: ProviderKeyProvider | null): string {
    const error = err instanceof ApiError ? err : { message: err instanceof Error ? err.message : undefined };
    return keyErrorText(error, provider?.label ?? "provider", provider ? engineLabel(provider.engine) : "Its engine");
  }

  function refresh(): void {
    void qc.invalidateQueries({ queryKey: providerKeysQueryKey });
    void qc.invalidateQueries({ queryKey: apiSurfacesQueryKey });
  }

  function replace(records: ProviderKey[]): void {
    qc.setQueryData<ProviderKeysValue>(providerKeysQueryKey, (current) => {
      if (!current) return current;
      const byId = new Map(records.map((r) => [r.id, r]));
      return { ...current, keys: current.keys.map((k) => byId.get(k.id) ?? k) };
    });
  }

  function openCreate(provider: ProviderId | null = null): void {
    editing = null;
    dialogProvider = provider;
    dialogOpen = true;
  }

  function openEdit(key: ProviderKey): void {
    editing = key;
    dialogProvider = key.provider;
    dialogOpen = true;
  }

  async function verify(key: ProviderKey): Promise<void> {
    if (verifying.has(key.id)) return;
    verifying = new Set([...verifying, key.id]);
    actionErrors = { ...actionErrors, [key.provider]: null };
    try {
      const record = await providerKeysApi.verify(key.id);
      replace([record]);
      const verdict = VERIFICATION[record.verification_state].label;
      announcement = `${record.label}: ${verdict}${record.verification_reason ? `, ${record.verification_reason}` : ""}`;
      if (record.verification_state === "valid") toast.success(`${record.label} verified`);
      else toast.error(`${record.label}: ${verdict}`, { description: record.verification_reason ?? undefined });
    } catch (err) {
      const text = describe(err, providerOf(key.provider));
      actionErrors = { ...actionErrors, [key.provider]: `Could not verify ${key.label}. ${text}` };
      toast.error(`Could not verify ${key.label}`, { description: text });
    } finally {
      const next = new Set(verifying);
      next.delete(key.id);
      verifying = next;
      refresh();
    }
  }

  const stateMutation = createMutation<ProviderKey, Error, ProviderKey>({
    mutationFn: (key) => providerKeysApi.setState(key.id, key.state === "active" ? "paused" : "active"),
    onMutate: (key) => {
      busyProvider = key.provider;
      actionErrors = { ...actionErrors, [key.provider]: null };
    },
    onSuccess: (record) => {
      replace([record]);
      toast.success(record.state === "active" ? `${record.label} resumed` : `${record.label} paused`);
      pauseOpen = false;
      pauseTarget = null;
    },
    onError: (err, key) => {
      const text = describe(err, providerOf(key.provider));
      if (pauseOpen) pauseError = text;
      else actionErrors = { ...actionErrors, [key.provider]: `Could not ${key.state === "active" ? "pause" : "resume"} ${key.label}. ${text}` };
    },
    onSettled: () => {
      busyProvider = null;
      refresh();
    },
  });

  function toggle(key: ProviderKey): void {
    // Pausing the last usable key of an API that answers with API key stops it: say so first (INT-4).
    if (key.state === "active" && isUsable(key) && consequence(key).lastUsable && providerOf(key.provider)?.source === "upstream") {
      pauseError = null;
      pauseTarget = key;
      pauseOpen = true;
      return;
    }
    $stateMutation.mutate(key);
  }

  const orderMutation = createMutation<{ keys: ProviderKey[] }, Error, { provider: ProviderId; ids: number[]; key: ProviderKey }>({
    mutationFn: ({ provider, ids }) => providerKeysApi.reorder(provider, ids),
    onMutate: ({ provider }) => {
      busyProvider = provider;
      actionErrors = { ...actionErrors, [provider]: null };
    },
    onSuccess: (result, { key, ids }) => {
      replace(result.keys);
      announcement = `${key.label} moved to position ${ids.indexOf(key.id) + 1}`;
    },
    onError: (err, { provider }) => {
      actionErrors = { ...actionErrors, [provider]: `Could not change the order. ${describe(err, providerOf(provider))}` };
    },
    onSettled: () => {
      busyProvider = null;
      refresh();
    },
  });

  function move(key: ProviderKey, delta: -1 | 1): void {
    const ids = keysOf(key.provider).map((k) => k.id);
    const next = moveIds(ids, ids.indexOf(key.id), delta);
    if (next) $orderMutation.mutate({ provider: key.provider, ids: next, key });
  }

  const deleteMutation = createMutation<unknown, Error, ProviderKey>({
    mutationFn: (key) => providerKeysApi.remove(key.id),
    onMutate: (key) => {
      busyProvider = key.provider;
      deleteError = null;
    },
    onSuccess: (_data, key) => {
      qc.setQueryData<ProviderKeysValue>(providerKeysQueryKey, (current) => current && { ...current, keys: current.keys.filter((k) => k.id !== key.id) });
      toast.success(`${key.label} deleted`);
      deleteOpen = false;
      deleteTarget = null;
    },
    onError: (err, key) => {
      deleteError = describe(err, providerOf(key.provider));
    },
    onSettled: () => {
      busyProvider = null;
      refresh();
    },
  });
</script>

<PageShell
  title="Provider keys"
  description="API keys of your OpenAI, Anthropic, xAI and Moonshot AI accounts. A gateway API spends them only while its source is API key; they never leave this server."
  width="wide"
>
  {#snippet actions()}
    {#if canManage && providers.length > 0}<Button onclick={() => openCreate()}><Plus class="h-4 w-4" />Add key</Button>{/if}
  {/snippet}

  {#if !canManage}
    <p class="text-body-sm text-muted-foreground">Read-only: adding, changing, ordering and deleting provider keys requires the <code class="font-mono">keys.manage</code> capability.</p>
  {/if}
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

  {#if $query.isPending}
    <StateBlock state="loading" />
  {:else if $query.isError && !data}
    <StateBlock state="error" cause={$query.error} message={`Could not load provider keys: ${errorText($query.error)}`} onRetry={() => void $query.refetch()} />
  {:else if data}
    {#if $query.isError}
      <StateBlock state="error" cause={$query.error} message={`Refresh failed. Showing previously loaded keys. ${errorText($query.error)}`} onRetry={() => void $query.refetch()} />
    {/if}
    <HiddenEngineNote count={hidden} />
    {#if providers.length === 0}
      <StateBlock state="empty" message="No provider available" description="Every engine is switched off fleet-wide, so no provider key can be used. Stored keys are kept.">
        {#snippet action()}<Button variant="outline" href={`${base}/engines`}>Open Engines</Button>{/snippet}
      </StateBlock>
    {/if}
    {#each providers as provider (provider.provider)}
      <ProviderKeyTable
        {provider}
        keys={keysOf(provider.provider)}
        {canManage}
        {verifying}
        busy={busyProvider === provider.provider}
        error={actionErrors[provider.provider] ?? null}
        onAdd={() => openCreate(provider.provider)}
        onEdit={openEdit}
        onVerify={(key) => void verify(key)}
        onToggle={toggle}
        onDelete={(key) => { deleteError = null; deleteTarget = key; deleteOpen = true; }}
        onMove={move}
      />
    {/each}
  {/if}
</PageShell>

{#if canManage}
  <ProviderKeyDialog bind:open={dialogOpen} {providers} {editing} defaultProvider={dialogProvider} />
{/if}

<ConfirmDialog
  bind:open={deleteOpen}
  size="md"
  title={deleteTarget ? `Delete ${deleteTarget.label}?` : "Delete provider key?"}
  description={deleteTarget ? `The ${providerOf(deleteTarget.provider)?.label ?? ""} key ${deleteTarget.key_hint} is removed from this server. It cannot be shown or restored; your provider account keeps it.` : undefined}
  confirmLabel="Delete key"
  busyLabel="Deleting…"
  destructive
  busy={$deleteMutation.isPending}
  error={deleteError}
  onConfirm={() => { if (deleteTarget) $deleteMutation.mutate(deleteTarget); }}
  onClose={() => { deleteTarget = null; deleteError = null; }}
>
  {#if deleteConsequence}
    <p class={deleteConsequence.lastUsable ? "text-body-sm text-warning" : "text-body-sm text-muted-foreground"}>{deleteConsequence.text}</p>
  {/if}
</ConfirmDialog>

<ConfirmDialog
  bind:open={pauseOpen}
  size="md"
  title={pauseTarget ? `Pause ${pauseTarget.label}?` : "Pause provider key?"}
  confirmLabel="Pause key"
  busyLabel="Pausing…"
  busy={$stateMutation.isPending}
  error={pauseError}
  onConfirm={() => { if (pauseTarget) $stateMutation.mutate(pauseTarget); }}
  onClose={() => { pauseTarget = null; pauseError = null; }}
>
  {#if pauseConsequence}<p class="text-body-sm text-warning">{pauseConsequence.text}</p>{/if}
</ConfirmDialog>
