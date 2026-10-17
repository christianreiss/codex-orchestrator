<script lang="ts">
  /** The secrets table: search, one primary action, reveal / edit / revoke per row. */
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Eye from "@lucide/svelte/icons/eye";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Plus from "@lucide/svelte/icons/plus";
  import * as Table from "$lib/components/ui/table";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { Toolbar, DataTable } from "$lib/components/page";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import { secretsApi, secretQueryKeys, agentUsage, ownerLabel } from "$lib/api/secrets";
  import type { AdminSecret, AdminSecretRevealResponse } from "$lib/api/types";
  import { relativeTime } from "$lib/utils/format";
  import { authStore } from "$lib/stores/auth";
  import { missingCapabilityReason } from "$lib/auth/capabilities";

  type Props = { onEdit?: (secret: AdminSecret) => void; onCreate?: () => void };
  let { onEdit, onCreate }: Props = $props();

  // Metadata is readable by every role; the plaintext and the lifecycle are
  // two separate grants, and the server enforces both independently.
  const canReveal = $derived($authStore.can("secrets.reveal"));
  const canManage = $derived($authStore.can("secrets.manage"));

  const qc = useQueryClient();
  const listKey = secretQueryKeys.list();

  let deleteOpen = $state(false);
  let deleteTarget = $state<AdminSecret | null>(null);
  let revealed = $state<AdminSecretRevealResponse | null>(null);

  const secretsQuery = createQuery<AdminSecret[]>({ queryKey: listKey, queryFn: () => secretsApi.list() });

  const revealMutation = createMutation<AdminSecretRevealResponse, Error, number>({
    mutationFn: (id) => secretsApi.reveal(id),
    onSuccess: (data) => { revealed = data; },
    onError: (err) => toast.error("Could not reveal the secret", { description: err.message }),
  });

  const deleteMutation = createMutation<unknown, Error, AdminSecret>({
    mutationFn: (secret) => secretsApi.remove(secret.id),
    onSuccess: (_data, secret) => {
      toast.success("Secret revoked", { description: `Agents asking for ${secret.slug} are refused from their next read on.` });
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: secretQueryKeys.state() });
    },
    onError: (err) => toast.error("Could not revoke the secret", { description: err.message }),
    onSettled: () => { deleteOpen = false; deleteTarget = null; },
  });

  const secrets = $derived($secretsQuery.data ?? []);

  let search = $state("");
  const q = $derived(search.trim().toLowerCase());
  const filtered = $derived(
    q
      ? secrets.filter((s) => [s.slug, s.name, s.description].some((v) => v?.toLowerCase().includes(q)) || s.tags.some((tag) => tag.toLowerCase().includes(q)))
      : secrets,
  );

  type SortKey = "slug" | "rotated";
  let sortKey = $state<SortKey>("slug");
  let sortDir = $state<"asc" | "desc">("asc");
  function onSort(key: SortKey) {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
  }
  const sorted = $derived.by(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = sortKey === "slug" ? a.slug.localeCompare(b.slug) : (a.last_rotated_at ?? "").localeCompare(b.last_rotated_at ?? "");
      if (cmp === 0) cmp = a.slug.localeCompare(b.slug);
      return cmp * dir;
    });
  });
</script>

<div class="space-y-3">
  <Toolbar
    bind:search
    searchPlaceholder="Search secrets"
    count={q ? `${sorted.length} of ${secrets.length}` : `${secrets.length} ${secrets.length === 1 ? "secret" : "secrets"}`}
  >
    {#snippet actions()}
      <Button onclick={() => onCreate?.()}><Plus class="h-4 w-4" />New secret</Button>
    {/snippet}
  </Toolbar>

  <DataTable
    items={sorted}
    loading={$secretsQuery.isLoading}
    error={$secretsQuery.isError ? `Could not load secrets: ${$secretsQuery.error?.message}` : null}
    onRetry={() => void $secretsQuery.refetch()}
    key={(s) => s.id}
    filtered={q !== ""}
    emptyIcon={KeyRound}
    emptyTitle="No secrets yet"
    emptyDescription="Add the credentials your agents need (API tokens, database passwords, service accounts) so they stop asking you for them."
    caption="Secrets"
  >
    {#snippet head()}
      <SortableHead label="Secret" active={sortKey === "slug"} dir={sortDir} onclick={() => onSort("slug")} />
      <Table.Head class="hidden md:table-cell">Used for</Table.Head>
      <Table.Head class="hidden lg:table-cell">Managed by</Table.Head>
      <SortableHead label="Rotated" active={sortKey === "rotated"} dir={sortDir} onclick={() => onSort("rotated")} class="hidden sm:table-cell" />
      <Table.Head class="w-12"><span class="sr-only">Actions</span></Table.Head>
    {/snippet}
    {#snippet row(secret)}
      <Table.Row>
        <Table.Cell class="align-top">
          <div class="font-mono text-body font-medium">{secret.slug}</div>
          <div class="text-caption text-muted-foreground">{secret.name}</div>
          {#if secret.tags.length > 0}
            <div class="mt-1 flex flex-wrap gap-1">
              {#each secret.tags as tag (tag)}<Badge variant="outline">{tag}</Badge>{/each}
            </div>
          {/if}
        </Table.Cell>
        <Table.Cell class="hidden max-w-md align-top text-body-sm text-muted-foreground md:table-cell">{secret.description ?? "—"}</Table.Cell>
        <Table.Cell class="hidden align-top lg:table-cell">
          <Badge variant={secret.source_host_id === null ? "outline" : "secondary"} title={secret.source_host_id === null ? "Agents cannot change it" : "Created by an agent over MCP"}>
            {ownerLabel(secret)}
          </Badge>
        </Table.Cell>
        <Table.Cell class="hidden align-top text-body-sm text-muted-foreground sm:table-cell">
          {secret.last_rotated_at ? relativeTime(secret.last_rotated_at) : "never"}
        </Table.Cell>
        <Table.Cell class="align-top text-right">
          <RowActions
            label={`Actions for ${secret.slug}`}
            actions={[
              { label: "Reveal", icon: Eye, disabled: !canReveal || $revealMutation.isPending, reason: canReveal ? undefined : missingCapabilityReason("secrets.reveal"), onClick: () => $revealMutation.mutate(secret.id) },
              { label: "Edit", icon: Pencil, disabled: !canManage, reason: canManage ? undefined : missingCapabilityReason("secrets.manage"), onClick: () => onEdit?.(secret) },
              { label: "Revoke", icon: Trash2, destructive: true, disabled: !canManage, reason: canManage ? undefined : missingCapabilityReason("secrets.manage"), onClick: () => { deleteTarget = secret; deleteOpen = true; } },
            ]}
          />
        </Table.Cell>
      </Table.Row>
    {/snippet}
  </DataTable>
</div>

<!-- Reveal. Deliberately a modal that must be dismissed rather than an inline
     unmask, so a plaintext credential cannot sit on screen unnoticed. -->
<Dialog.Root open={revealed !== null} onOpenChange={(next) => { if (!next) revealed = null; }}>
  <Dialog.Content class="sm:max-w-lg">
    {#if revealed}
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2"><KeyRound class="h-5 w-5" />{revealed.secret.slug}</Dialog.Title>
        <Dialog.Description>{revealed.secret.name}</Dialog.Description>
      </Dialog.Header>

      <Alert variant="warning">
        <TriangleAlert class="h-4 w-4" />
        <AlertTitle>This is a live credential</AlertTitle>
        <AlertDescription>Anyone reading your screen can read it. Agents fetch it themselves over MCP, so you normally do not need to copy it anywhere.</AlertDescription>
      </Alert>

      <div class="flex items-center gap-2">
        <code class="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-caption">{revealed.value}</code>
        <CopyButton value={revealed.value} variant="outline" size="icon" aria-label="Copy value" toastMessage="Value copied to clipboard" />
      </div>

      <p class="text-caption text-muted-foreground">
        An agent reads this with <code class="font-mono">{agentUsage(revealed.secret.slug)}</code>. Every such read is recorded in the MCP audit log against the host that made it.
      </p>

      <Dialog.Footer><Button onclick={() => (revealed = null)}>Done</Button></Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  bind:open={deleteOpen}
  title={`Revoke ${deleteTarget?.slug ?? "secret"}?`}
  description="Agents are refused from their next read on; nothing is cached on any host. The slug stays reserved, so adding it again later revives the entry with a fresh value."
  confirmLabel="Revoke"
  destructive
  busy={$deleteMutation.isPending}
  onConfirm={() => { if (deleteTarget) $deleteMutation.mutate(deleteTarget); }}
/>
