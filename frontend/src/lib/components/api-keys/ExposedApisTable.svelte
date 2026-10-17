<script lang="ts">
  import { toast } from "svelte-sonner";
  import * as Table from "$lib/components/ui/table";
  import { DataTable } from "$lib/components/page";
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { apiSurfaceMutation, apiSurfacesQuery } from "$lib/api/settings";
  import type { ApiBackendEngine, ApiKeyEngine, ApiSurfaceId, ApiSurfaceRow } from "$lib/api/types";
  import { useFleetEngines, fleetDisabledTitle } from "$lib/engines/fleet-engines";

  type Props = { onShowKeys?: (tab: ApiKeyEngine) => void };
  let { onShowKeys }: Props = $props();

  /** Key tabs are per surface; their ids predate the surface naming. */
  const KEY_TAB: Record<ApiSurfaceId, ApiKeyEngine> = { openai: "openai", anthropic: "claude", grok: "grok" };
  const WIRE_LABEL = { openai: "OpenAI wire", anthropic: "Anthropic wire" } as const;

  const query = apiSurfacesQuery();
  const mutation = apiSurfaceMutation({ onError: (err) => toast.error(err.message) });

  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const rows = $derived($query.data?.surfaces ?? []);
  const backends = $derived($query.data?.backends ?? []);
  const backendLabel = (engine: ApiBackendEngine) => backends.find((b) => b.engine === engine)?.label ?? engine;
  // Routing an API to a fleet-disabled backend is refused (409), and an API
  // whose current backend is off answers 503 until it comes back.
  const fleet = useFleetEngines();

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
  error={$query.isError ? `Failed to load exposed APIs: ${$query.error?.message}` : null}
  onRetry={() => void $query.refetch()}
  key={(row) => row.surface}
  caption="Exposed APIs"
>
  {#snippet head()}
    <Table.Head>API</Table.Head>
    <Table.Head>Base URL</Table.Head>
    <Table.Head>Default engine</Table.Head>
    <Table.Head class="text-center">Enabled</Table.Head>
    <Table.Head class="text-right">Keys</Table.Head>
  {/snippet}
  {#snippet row(row)}
    {@const url = `${origin}${row.base_path}`}
    <Table.Row>
      <Table.Cell>
        <p class="text-body font-medium">{row.label}</p>
        <p class="text-caption text-muted-foreground">{WIRE_LABEL[row.wire]}</p>
      </Table.Cell>
      <Table.Cell>
        <div class="flex items-center gap-2">
          <code class="truncate font-mono text-caption text-muted-foreground">{url}</code>
          <CopyButton value={url} label="Copy" copiedLabel="Copied" size="sm" toastMessage={`${row.base_path} URL copied`} />
        </div>
      </Table.Cell>
      <Table.Cell>
        <div class="flex items-center gap-2">
          <Select.Root type="single" value={row.backend} onValueChange={(v) => setBackend(row, v)} disabled={$mutation.isPending}>
            <Select.Trigger id={`api-backend-${row.surface}`} class="w-32" aria-label={`Backend for ${row.base_path}`}>
              {backendLabel(row.backend)}
            </Select.Trigger>
            <Select.Content>
              {#each backends as b (b.engine)}
                {@const off = !$fleet.isEnabled(b.engine)}
                <!-- The current backend stays selectable even when off, so the trigger keeps a matching item. -->
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
          {#if row.backend !== row.identity_backend}
            <Badge variant="info" title={`Native backend: ${backendLabel(row.identity_backend)}`}>rerouted</Badge>
          {/if}
          {#if !$fleet.isEnabled(row.backend)}
            <Badge
              variant="warning"
              title={`${backendLabel(row.backend)} is disabled fleet-wide, so ${row.base_path} answers 503 until it is turned back on or rerouted.`}
            >backend off</Badge>
          {/if}
        </div>
      </Table.Cell>
      <Table.Cell class="text-center">
        <Switch checked={!row.disabled} onCheckedChange={(v) => setEnabled(row, v)} disabled={$mutation.isPending} aria-label={`Enable ${row.base_path}`} />
      </Table.Cell>
      <Table.Cell class="text-right">
        <Button variant="link" size="sm" class="h-auto p-0 tabular-nums" onclick={() => onShowKeys?.(KEY_TAB[row.surface])}>
          {row.key_count} active
        </Button>
      </Table.Cell>
    </Table.Row>
  {/snippet}
</DataTable>
<details class="mt-2 text-caption text-muted-foreground">
  <summary class="w-fit cursor-pointer py-1">How routing works</summary>
  <p class="mt-1 max-w-prose leading-relaxed">
    Each API keeps its URL, wire format, keys and on/off switch; the default engine serves keys without an engine assignment. Keys with an assigned engine keep using it when this default changes.
    Limits follow the backend: Grok refuses streaming and images, Codex reports no token usage, and a model id
    native to the API that the backend does not serve runs on the backend's default model.
  </p>
</details>
