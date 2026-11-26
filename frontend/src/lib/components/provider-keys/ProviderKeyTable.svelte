<script lang="ts">
  /**
   * One provider's keys in failover order: the order is the table order, and the
   * arrows are the non-drag way to change it. Every row action is a separate
   * control (INT-1); without `keys.manage` the table is read-only.
   */
  import { base } from "$app/paths";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import KeySquare from "@lucide/svelte/icons/key-square";
  import Pause from "@lucide/svelte/icons/pause";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Play from "@lucide/svelte/icons/play";
  import Plus from "@lucide/svelte/icons/plus";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { DataTable, Section, Timestamp } from "$lib/components/page";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import type { ProviderKey, ProviderKeyProvider } from "$lib/api/types";
  import { isUsable, SOURCE_LABEL, VERIFICATION } from "./provider-key-model";

  type Props = {
    provider: ProviderKeyProvider;
    /** This provider's keys, already in failover order. */
    keys: readonly ProviderKey[];
    canManage: boolean;
    /** Ids whose verification is in flight. */
    verifying: ReadonlySet<number>;
    /** A reorder, pause or delete for this provider is in flight. */
    busy: boolean;
    /** The last failed action on this provider, shown beside the table (INT-5). */
    error?: string | null;
    onAdd: () => void;
    onEdit: (key: ProviderKey) => void;
    onVerify: (key: ProviderKey) => void;
    onToggle: (key: ProviderKey) => void;
    onDelete: (key: ProviderKey) => void;
    onMove: (key: ProviderKey, delta: -1 | 1) => void;
  };
  let { provider, keys, canManage, verifying, busy, error = null, onAdd, onEdit, onVerify, onToggle, onDelete, onMove }: Props = $props();

  const usable = $derived(keys.filter(isUsable).length);
  const upstream = $derived(provider.source === "upstream");
  const api = $derived(provider.base_path ?? "its API");
</script>

<Section id={`provider-${provider.provider}`} title={provider.label} description={`Answers ${api} while its source is API key, billed to your ${provider.label} account.`}>
  <div class="space-y-2">
    <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground">
      <span>Source of {api}:</span>
      <Badge variant={upstream ? "info" : "secondary"}>{SOURCE_LABEL[provider.source]}</Badge>
      <a class="text-primary underline-offset-2 hover:underline" href={`${base}/api-keys#exposed-apis`}>Change under API keys</a>
    </p>
    {#if keys.length > 0}<p class="text-body-sm text-muted-foreground">{usable} of {keys.length} {keys.length === 1 ? "key" : "keys"} usable, tried in this order.</p>{/if}
    {#if upstream && usable === 0}
      <p role="status" class="text-body-sm text-warning">
        {api} answers with API key, but no {provider.label} key is usable: its requests fail (503) until a key is added or resumed.
      </p>
    {/if}
    {#if error}<p role="alert" class="text-body-sm text-destructive">{error}</p>{/if}

    <DataTable
      reflow
      items={[...keys]}
      key={(k) => k.id}
      caption={`${provider.label} keys`}
      emptyIcon={KeySquare}
      emptyTitle={`No ${provider.label} keys`}
      emptyDescription={`Keys are tried in order: when the provider refuses a key (401, 403, 429) or cannot be reached, the next one takes over. ${api} needs one before its source can be API key.`}
    >
      {#snippet emptyAction()}
        {#if canManage}<Button variant="outline" onclick={onAdd}><Plus class="h-4 w-4" />Add {provider.label} key</Button>{/if}
      {/snippet}
      {#snippet head()}
        <Table.Head class="w-24">Order</Table.Head>
        <Table.Head>Name</Table.Head>
        <Table.Head>Key</Table.Head>
        <Table.Head>Endpoint</Table.Head>
        <Table.Head>Status</Table.Head>
        <Table.Head>Last used</Table.Head>
        <Table.Head>Last error</Table.Head>
        {#if canManage}<Table.Head class="w-12"><span class="sr-only">Actions</span></Table.Head>{/if}
      {/snippet}
      {#snippet row(entry, index)}
        {@const verdict = VERIFICATION[entry.verification_state]}
        {@const checking = verifying.has(entry.id)}
        <Table.Row data-key-id={entry.id}>
          <Table.Cell class="whitespace-nowrap">
            <div class="flex items-center gap-1">
              <span class="min-w-6 tabular-nums text-body-sm"><span class="text-muted-foreground sm:hidden">Order&nbsp;</span>{index + 1}</span>
              {#if canManage && keys.length > 1}
                <Button variant="ghost" size="icon" class="h-8 w-8" aria-label={`Move ${entry.label} up`} disabled={busy || index === 0} onclick={() => onMove(entry, -1)}><ArrowUp class="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" class="h-8 w-8" aria-label={`Move ${entry.label} down`} disabled={busy || index === keys.length - 1} onclick={() => onMove(entry, 1)}><ArrowDown class="h-4 w-4" /></Button>
              {/if}
            </div>
          </Table.Cell>
          <Table.Cell class="min-w-32 break-words font-medium [overflow-wrap:anywhere]">{entry.label}</Table.Cell>
          <Table.Cell><code class="whitespace-nowrap font-mono text-caption">{entry.key_hint}</code></Table.Cell>
          <Table.Cell class="min-w-60">
            <code class="block font-mono text-caption [overflow-wrap:anywhere]">{entry.effective_base_url ?? provider.default_base_url}</code>
            <span class="text-caption text-muted-foreground">{entry.base_url ? "Custom base URL" : "Provider default"}</span>
          </Table.Cell>
          <Table.Cell class="min-w-36">
            <div class="flex flex-wrap items-center gap-1">
              <Badge variant={entry.state === "active" ? "secondary" : "outline"}>{entry.state === "active" ? "Active" : "Paused"}</Badge>
              {#if checking}
                <span role="status" class="text-caption text-muted-foreground">Checking…</span>
              {:else}
                <Badge variant={verdict.tone}>{verdict.label}</Badge>
              {/if}
            </div>
            {#if !checking}
              <div class="mt-0.5 text-caption text-muted-foreground">
                {#if entry.verification_reason}<span>{entry.verification_reason}</span>{/if}
                {#if entry.verification_checked_at}{#if entry.verification_reason}<span aria-hidden="true" class="mx-1">·</span>{/if}<span>checked <Timestamp value={entry.verification_checked_at} /></span>{/if}
                {#if entry.verification_state === "invalid"}<div>Skipped in failover</div>{:else if entry.state === "paused"}<div>Not tried while paused</div>{/if}
              </div>
            {/if}
          </Table.Cell>
          <Table.Cell class="whitespace-nowrap text-body-sm">
            <span class="text-muted-foreground sm:hidden">Last used:&nbsp;</span><Timestamp value={entry.last_used_at} fallback="Never" />
          </Table.Cell>
          <Table.Cell class="min-w-32 text-body-sm">
            <span class="text-muted-foreground sm:hidden">Last error:&nbsp;</span>
            {#if entry.last_error_at}
              <Timestamp value={entry.last_error_at} />
              <div class="text-caption text-muted-foreground">{entry.last_error_reason ?? (entry.last_error_status ? `HTTP ${entry.last_error_status}` : "Unknown error")}</div>
            {:else}
              <span class="text-muted-foreground">None</span>
            {/if}
          </Table.Cell>
          {#if canManage}
            <Table.Cell class="w-12 text-right max-sm:absolute max-sm:right-1 max-sm:top-1 max-sm:w-auto">
              <RowActions
                label={`Actions for ${entry.label}`}
                actions={[
                  { label: "Verify key", icon: ShieldCheck, disabled: checking, onClick: () => onVerify(entry) },
                  entry.state === "active"
                    ? { label: "Pause key", icon: Pause, disabled: busy, onClick: () => onToggle(entry) }
                    : { label: "Resume key", icon: Play, disabled: busy, onClick: () => onToggle(entry) },
                  { label: "Edit key", icon: Pencil, onClick: () => onEdit(entry) },
                  { label: "Delete key", icon: Trash2, destructive: true, disabled: busy, onClick: () => onDelete(entry) },
                ]}
              />
            </Table.Cell>
          {/if}
        </Table.Row>
      {/snippet}
    </DataTable>
  </div>
</Section>
