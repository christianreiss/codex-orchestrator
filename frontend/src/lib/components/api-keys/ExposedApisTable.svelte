<script lang="ts">
  import { base } from "$app/paths";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Table from "$lib/components/ui/table";
  import { DataTable } from "$lib/components/page";
  import * as Select from "$lib/components/ui/select";
  import { SimpleSelect } from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { apiSurfaceMutation, apiSurfacesQuery, apiSurfacesQueryKey } from "$lib/api/settings";
  import { providerKeysApi, providerKeysQueryKey } from "$lib/api/provider-keys";
  import type { ApiBackendEngine, ApiKeyEngine, ApiSource, ApiSurfaceId, ApiSurfaceRow } from "$lib/api/types";
  import { ApiError } from "$lib/api/client";
  import { useFleetEngines, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import { loadFailure } from "$lib/api/access-denied";
  import { authStore } from "$lib/stores/auth";
  import { missingCapabilityReason } from "$lib/auth/capabilities";
  import { keyErrorText, SOURCE_LABEL } from "$lib/components/provider-keys/provider-key-model";

  type Props = { onShowKeys?: (tab: ApiKeyEngine) => void };
  let { onShowKeys }: Props = $props();

  /** Key tabs are per surface; their ids predate the surface naming. */
  const KEY_TAB: Record<ApiSurfaceId, ApiKeyEngine> = { openai: "openai", anthropic: "claude", grok: "grok", kimi: "kimi" };
  const WIRE_LABEL = { openai: "OpenAI wire", anthropic: "Anthropic wire" } as const;
  const SOURCE_OPTIONS = [
    { value: "emulated", label: SOURCE_LABEL.emulated },
    { value: "upstream", label: SOURCE_LABEL.upstream },
  ] as const;

  const qc = useQueryClient();
  const query = apiSurfacesQuery();
  const mutation = apiSurfaceMutation({ onError: (err) => toast.error(err.message) });

  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const rows = $derived($query.data?.surfaces ?? []);
  const backends = $derived($query.data?.backends ?? []);
  const backendLabel = (engine: ApiBackendEngine) => backends.find((b) => b.engine === engine)?.label ?? engine;
  // Routing an API to a fleet-disabled backend is refused (409), and an API
  // whose current backend is off answers 503 until it comes back.
  const fleet = useFleetEngines();
  // Choosing the source spends provider keys, so it is `keys.manage`, not `settings.manage`.
  const canSetSource = $derived($authStore.can("keys.manage"));

  // Older servers omit the source fields: that is the subscription path with no provider keys.
  const sourceOf = (row: ApiSurfaceRow): ApiSource => row.source ?? "emulated";
  const providerName = (row: ApiSurfaceRow) => row.provider_label ?? "the provider";
  const usableKeys = (row: ApiSurfaceRow) => row.provider_keys?.usable ?? 0;
  // The provider path is gated by the master switch of the API's own engine (OpenAI by Codex, and so on).
  const providerEngine = (row: ApiSurfaceRow) => row.identity_backend;
  const providerKeysHref = (row: ApiSurfaceRow) => `${base}/provider-keys${row.provider ? `#provider-${row.provider}` : ""}`;

  let sourceTarget = $state<ApiSurfaceRow | null>(null);
  let sourceOpen = $state(false);
  let sourceError = $state<string | null>(null);

  const sourceMutation = createMutation<ApiSurfaceRow, Error, { row: ApiSurfaceRow; source: ApiSource }>({
    mutationFn: ({ row, source }) => providerKeysApi.setSurfaceSource(row.surface, source),
    onSuccess: (_data, { row, source }) => {
      toast.success(`${row.base_path} now answers with ${source === "upstream" ? `${providerName(row)} API keys` : "Subscription"}`);
      sourceOpen = false;
      sourceTarget = null;
    },
    onError: (err, { row, source }) => {
      const text = keyErrorText(err instanceof ApiError ? err : { message: err.message }, providerName(row), backendLabel(providerEngine(row)));
      if (source === "upstream") sourceError = text;
      else toast.error(`Could not switch ${row.base_path} to Subscription`, { description: text });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: apiSurfacesQueryKey });
      void qc.invalidateQueries({ queryKey: providerKeysQueryKey });
    },
  });

  function setSource(row: ApiSurfaceRow, value: string) {
    if (value === sourceOf(row) || (value !== "emulated" && value !== "upstream")) return;
    if (value === "emulated") {
      // Going back to the subscription costs nothing and needs no confirmation.
      $sourceMutation.mutate({ row, source: "emulated" });
      return;
    }
    sourceError = null;
    sourceTarget = row;
    sourceOpen = true;
  }

  function setBackend(row: ApiSurfaceRow, value: string | undefined) {
    const backend = backends.find((b) => b.engine === value)?.engine;
    if (!backend || backend === row.backend) return;
    $mutation.mutate(
      { surface: row.surface, backend },
      { onSuccess: () => toast.success(`${row.base_path} now served by ${backendLabel(backend)}`) },
    );
  }

  function setEnabled(row: ApiSurfaceRow, enabled: boolean) {
    $mutation.mutate(
      { surface: row.surface, disabled: !enabled },
      { onSuccess: () => toast.success(`${row.base_path} ${enabled ? "enabled" : "disabled"}`) },
    );
  }
</script>

<DataTable
  items={rows}
  loading={$query.isPending}
  error={$query.isError ? loadFailure($query.error, "Failed to load exposed APIs") : null}
  onRetry={() => void $query.refetch()}
  key={(row) => row.surface}
  caption="Exposed APIs"
  reflow
>
  {#snippet head()}
    <Table.Head>API</Table.Head>
    <Table.Head>Base URL</Table.Head>
    <Table.Head>Source</Table.Head>
    <Table.Head>Default engine</Table.Head>
    <Table.Head class="text-center">Enabled</Table.Head>
    <Table.Head class="text-right">Keys</Table.Head>
  {/snippet}
  {#snippet row(row)}
    {@const url = `${origin}${row.base_path}`}
    {@const source = sourceOf(row)}
    {@const upstream = source === "upstream"}
    <Table.Row>
      <Table.Cell>
        <p class="text-body font-medium">{row.label}</p>
        <p class="text-caption text-muted-foreground">{WIRE_LABEL[row.wire]}</p>
      </Table.Cell>
      <Table.Cell>
        <div class="flex min-w-0 items-center gap-2">
          <code class="min-w-0 font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">{url}</code>
          <CopyButton value={url} label="Copy" copiedLabel="Copied" size="sm" toastMessage={`${row.base_path} URL copied`} />
        </div>
      </Table.Cell>
      <Table.Cell>
        <p class="text-caption text-muted-foreground sm:hidden">Source</p>
        <div class="flex flex-wrap items-center gap-2">
          <span title={canSetSource ? undefined : missingCapabilityReason("keys.manage")}>
            <SimpleSelect
              id={`api-source-${row.surface}`}
              class="w-36"
              aria-label={`Source for ${row.base_path}`}
              value={source}
              options={SOURCE_OPTIONS}
              disabled={!canSetSource || $sourceMutation.isPending}
              onValueChange={(value) => setSource(row, value)}
            />
          </span>
          {#if upstream && usableKeys(row) === 0}
            <a href={providerKeysHref(row)} class="rounded-md">
              <Badge variant="warning" title={`${row.base_path} answers 503 until one of its ${providerName(row)} keys is active and not rejected.`}>No usable {providerName(row)} key</Badge>
            </a>
          {:else if upstream && !$fleet.isEnabled(providerEngine(row))}
            <Badge variant="warning" title={`The ${backendLabel(providerEngine(row))} master switch also gates the ${providerName(row)} key path, so ${row.base_path} answers 503 until it is turned back on.`}>{backendLabel(providerEngine(row))} off</Badge>
          {/if}
        </div>
        {#if upstream}<p class="mt-1 text-caption text-muted-foreground">{providerName(row)}, {usableKeys(row)} usable {usableKeys(row) === 1 ? "key" : "keys"}</p>{/if}
      </Table.Cell>
      <Table.Cell>
        <p class="text-caption text-muted-foreground sm:hidden">Default engine</p>
        <div class="flex items-center gap-2">
          <span title={upstream ? `Not used while the source is API key: ${row.base_path} is forwarded to ${providerName(row)}.` : undefined}>
            <Select.Root type="single" value={row.backend} onValueChange={(v) => setBackend(row, v)} disabled={$mutation.isPending || upstream}>
              <Select.Trigger id={`api-backend-${row.surface}`} class="w-32" aria-label={`Backend for ${row.base_path}`}>
                {backendLabel(row.backend)}
              </Select.Trigger>
              <Select.Content>
                <!-- Only engines switched on fleet-wide are offered; the current backend stays
                     listed even when off, so the trigger keeps a matching item. -->
                {#each backends.filter((b) => $fleet.isEnabled(b.engine) || b.engine === row.backend) as b (b.engine)}
                  {@const off = !$fleet.isEnabled(b.engine)}
                  <Select.Item
                    value={b.engine}
                    label={b.label}
                    disabled={off && b.engine !== row.backend}
                    title={off ? fleetDisabledTitle(b.label) : undefined}
                  >
                    {b.label}{#if off}<span class="ml-1.5 text-caption text-muted-foreground">(off)</span>{/if}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </span>
          {#if row.backend !== row.identity_backend}
            <Badge variant="info" title={`Native backend: ${backendLabel(row.identity_backend)}`}>rerouted</Badge>
          {/if}
          {#if !upstream && !$fleet.isEnabled(row.backend)}
            <Badge
              variant="warning"
              title={`${backendLabel(row.backend)} is disabled fleet-wide, so ${row.base_path} answers 503 until it is turned back on or rerouted.`}
            >backend off</Badge>
          {/if}
        </div>
        {#if upstream}<p class="mt-1 text-caption text-muted-foreground">Not used with API key</p>{/if}
      </Table.Cell>
      <Table.Cell class="text-center max-sm:text-left">
        <span class="mr-2 align-middle text-caption text-muted-foreground sm:hidden" aria-hidden="true">Enabled</span>
        <Switch checked={!row.disabled} onCheckedChange={(v) => setEnabled(row, v)} disabled={$mutation.isPending} aria-label={`Enable ${row.base_path}`} />
      </Table.Cell>
      <Table.Cell class="text-right max-sm:text-left">
        <span class="text-caption text-muted-foreground sm:hidden">Gateway keys:</span>
        <Button variant="link" size="sm" class="tabular-nums max-sm:px-1" onclick={() => onShowKeys?.(KEY_TAB[row.surface])}>
          {row.key_count} active
        </Button>
      </Table.Cell>
    </Table.Row>
  {/snippet}
</DataTable>
<details class="mt-2 text-caption text-muted-foreground">
  <summary class="w-fit cursor-pointer py-1">How routing works</summary>
  <div class="mt-1 max-w-prose space-y-2 leading-relaxed">
    <p>
      Each API keeps its URL, wire format, gateway keys and on/off switch. Its <span class="font-medium text-foreground">source</span> decides who answers, and the two sources never fall back to each other.
    </p>
    <p>
      <span class="font-medium text-foreground">Subscription</span>: a subscription account of the default engine answers through the runner. Gateway keys with an assigned engine keep it when the default changes. Limits follow the engine: Grok refuses streaming and images, Codex reports no token usage, and a model id native to the API that the engine does not serve runs on the engine's default model.
    </p>
    <p>
      <span class="font-medium text-foreground">API key</span>: the request goes unchanged to the API's own provider (OpenAI for /v1, Anthropic for /anthropic/v1, xAI for /grok/v1, Moonshot AI for /kimi/v1) with the key in use under <a class="text-primary underline-offset-2 hover:underline" href={`${base}/provider-keys`}>Provider keys</a> (when it fails, the next key takes over and stays in use), and is billed to that provider account. The default engine, model policy and tiers do not apply; the API's own engine switch under Engines still does.
    </p>
    <p>A gateway key created with its own source keeps it when this default changes.</p>
  </div>
</details>

<ConfirmDialog
  bind:open={sourceOpen}
  size="md"
  title={sourceTarget ? `Answer ${sourceTarget.base_path} with ${providerName(sourceTarget)} API keys?` : "Switch to API key?"}
  description={sourceTarget
    ? `Requests to ${sourceTarget.base_path} from gateway keys without their own source go unchanged to ${providerName(sourceTarget)} with the stored provider keys and are billed to that ${providerName(sourceTarget)} account. Subscriptions stop answering them, and the default engine, model policy and tiers no longer apply.`
    : undefined}
  confirmLabel="Switch to API key"
  busyLabel="Switching…"
  busy={$sourceMutation.isPending}
  confirmDisabled={!sourceTarget || usableKeys(sourceTarget) === 0}
  error={sourceError}
  onConfirm={() => { if (sourceTarget) { sourceError = null; $sourceMutation.mutate({ row: sourceTarget, source: "upstream" }); } }}
  onClose={() => { sourceTarget = null; sourceError = null; }}
>
  {#if sourceTarget}
    {#if usableKeys(sourceTarget) === 0}
      <p class="text-body-sm text-warning" role="status">
        No usable {providerName(sourceTarget)} key is stored, so {sourceTarget.base_path} would answer 503.
        <a class="text-primary underline-offset-2 hover:underline" href={providerKeysHref(sourceTarget)}>Add one under Provider keys</a> first.
      </p>
    {:else}
      <p class="text-body-sm text-muted-foreground">
        {usableKeys(sourceTarget)} usable {providerName(sourceTarget)} {usableKeys(sourceTarget) === 1 ? "key" : "keys"}, tried in the order set under <a class="text-primary underline-offset-2 hover:underline" href={providerKeysHref(sourceTarget)}>Provider keys</a>. Gateway keys pinned to Subscription keep it.
      </p>
    {/if}
  {/if}
</ConfirmDialog>
