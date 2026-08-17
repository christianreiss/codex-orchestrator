<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Eye from "@lucide/svelte/icons/eye";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Search from "@lucide/svelte/icons/search";
  import Plus from "@lucide/svelte/icons/plus";
  import * as Table from "$lib/components/ui/table";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import { secretsApi, secretQueryKeys, engineScopeLabel, agentUsage, ownerLabel } from "$lib/api/secrets";
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

  let deleteTarget = $state<AdminSecret | null>(null);
  let revealed = $state<AdminSecretRevealResponse | null>(null);

  const secretsQuery = createQuery<AdminSecret[]>({
    queryKey: listKey,
    queryFn: () => secretsApi.list(),
  });

  const revealMutation = createMutation<AdminSecretRevealResponse, Error, number>({
    mutationFn: (id) => secretsApi.reveal(id),
    onSuccess: (data) => {
      revealed = data;
    },
    onError: (err) => {
      toast.error("Could not reveal the secret", { description: err.message });
    },
  });

  const deleteMutation = createMutation<unknown, Error, AdminSecret>({
    mutationFn: (secret) => secretsApi.remove(secret.id),
    onSuccess: (_data, secret) => {
      toast.success("Secret revoked", {
        description: `Agents asking for ${secret.slug} are refused from their next read on.`,
      });
      void qc.invalidateQueries({ queryKey: listKey });
      void qc.invalidateQueries({ queryKey: secretQueryKeys.state() });
    },
    onError: (err) => {
      toast.error("Could not revoke the secret", { description: err.message });
    },
    onSettled: () => {
      deleteTarget = null;
    },
  });

  const secrets = $derived($secretsQuery.data ?? []);

  // ---- Search ----
  let search = $state("");
  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return secrets;
    return secrets.filter(
      (s) =>
        [s.slug, s.name, s.description].some((v) => v?.toLowerCase().includes(q)) ||
        s.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  });

  // ---- Sort ----
  type SortKey = "slug" | "rotated";
  let sortKey = $state<SortKey>("slug");
  let sortDir = $state<"asc" | "desc">("asc");
  function onSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
  }
  const sorted = $derived.by(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "slug":
          cmp = a.slug.localeCompare(b.slug);
          break;
        case "rotated":
          cmp = (a.last_rotated_at ?? "").localeCompare(b.last_rotated_at ?? "");
          break;
      }
      if (cmp === 0) cmp = a.slug.localeCompare(b.slug);
      return cmp * dir;
    });
  });
</script>

<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div class="relative w-full sm:max-w-sm">
    <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    <Input
      bind:value={search}
      placeholder="Search by slug, name, description, tag..."
      class="pl-9"
      aria-label="Search secrets"
    />
  </div>
  <div class="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
    <p class="mr-1 text-xs text-muted-foreground">
      {#if search.trim()}
        Showing {sorted.length} of {secrets.length}
      {:else}
        {secrets.length} {secrets.length === 1 ? "secret" : "secrets"}
      {/if}
    </p>
    <Button size="sm" onclick={() => onCreate?.()}>
      <Plus class="h-4 w-4" />
      New secret
    </Button>
  </div>
</div>

{#if $secretsQuery.isLoading}
  <div class="space-y-2">
    {#each Array(3) as _, i (i)}
      <Skeleton class="h-12 w-full" />
    {/each}
  </div>
{:else if $secretsQuery.isError}
  <Alert variant="destructive">
    <TriangleAlert class="h-4 w-4" />
    <AlertTitle>Could not load secrets</AlertTitle>
    <AlertDescription>{$secretsQuery.error?.message}</AlertDescription>
  </Alert>
{:else if secrets.length === 0}
  <div class="rounded-lg border border-dashed">
    <EmptyState
      icon={KeyRound}
      title="No secrets yet"
      description="Add the credentials your agents need — API tokens, database passwords, service accounts — so they stop asking you for them or hunting through config files."
    >
      {#snippet action()}
        <Button size="sm" onclick={() => onCreate?.()}>
          <Plus class="h-4 w-4" />
          New secret
        </Button>
      {/snippet}
    </EmptyState>
  </div>
{:else if sorted.length === 0}
  <div class="rounded-lg border border-dashed">
    <EmptyState
      icon={Search}
      title={`No secrets match "${search.trim()}"`}
      description="Try a different search."
    >
      {#snippet action()}
        <Button size="sm" variant="outline" onclick={() => (search = "")}>Clear search</Button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="overflow-x-auto rounded-lg border">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <SortableHead label="Slug" active={sortKey === "slug"} dir={sortDir} onclick={() => onSort("slug")} />
          <Table.Head>What it is for</Table.Head>
          <Table.Head>Scope</Table.Head>
          <Table.Head>Managed by</Table.Head>
          <SortableHead
            label="Rotated"
            active={sortKey === "rotated"}
            dir={sortDir}
            onclick={() => onSort("rotated")}
          />
          <Table.Head class="text-right">Actions</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each sorted as secret (secret.id)}
          <Table.Row>
            <Table.Cell class="align-top">
              <div class="font-mono text-sm font-medium">{secret.slug}</div>
              <div class="text-xs text-muted-foreground">{secret.name}</div>
              {#if secret.tags.length > 0}
                <div class="mt-1 flex flex-wrap gap-1">
                  {#each secret.tags as tag (tag)}
                    <Badge variant="outline" class="text-[10px]">{tag}</Badge>
                  {/each}
                </div>
              {/if}
            </Table.Cell>
            <Table.Cell class="max-w-md align-top text-sm text-muted-foreground">
              {secret.description ?? "—"}
            </Table.Cell>
            <Table.Cell class="align-top">
              <Badge variant="secondary">{engineScopeLabel(secret.engine)}</Badge>
            </Table.Cell>
            <Table.Cell class="align-top">
              <Badge variant={secret.source_host_id === null ? "outline" : "secondary"}>
                {ownerLabel(secret)}
              </Badge>
              {#if secret.source_host_id === null}
                <div class="mt-1 text-xs text-muted-foreground">agents cannot change it</div>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-sm text-muted-foreground">
              {secret.last_rotated_at ? relativeTime(secret.last_rotated_at) : "never"}
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <RowActions
                label={`Actions for ${secret.slug}`}
                actions={[
                  {
                    label: "Reveal",
                    icon: Eye,
                    disabled: !canReveal || $revealMutation.isPending,
                    reason: canReveal ? undefined : missingCapabilityReason("secrets.reveal"),
                    onClick: () => $revealMutation.mutate(secret.id),
                  },
                  {
                    label: "Edit",
                    icon: Pencil,
                    disabled: !canManage,
                    reason: canManage ? undefined : missingCapabilityReason("secrets.manage"),
                    onClick: () => onEdit?.(secret),
                  },
                  {
                    label: "Revoke",
                    icon: Trash2,
                    destructive: true,
                    disabled: !canManage,
                    reason: canManage ? undefined : missingCapabilityReason("secrets.manage"),
                    onClick: () => (deleteTarget = secret),
                  },
                ]}
              />
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

<!-- Reveal. Deliberately a modal that must be dismissed rather than an inline
     unmask, so a plaintext credential cannot sit on screen unnoticed. -->
<Dialog.Root
  open={revealed !== null}
  onOpenChange={(next) => {
    if (!next) revealed = null;
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    {#if revealed}
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2">
          <KeyRound class="h-5 w-5" />
          {revealed.secret.slug}
        </Dialog.Title>
        <Dialog.Description>{revealed.secret.name}</Dialog.Description>
      </Dialog.Header>

      <Alert variant="warning">
        <TriangleAlert class="h-4 w-4" />
        <AlertTitle>This is a live credential</AlertTitle>
        <AlertDescription>
          Anyone reading your screen can read it. Agents fetch it themselves over MCP — you
          normally do not need to copy it anywhere.
        </AlertDescription>
      </Alert>

      <div class="flex items-center gap-2">
        <code class="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs"
          >{revealed.value}</code
        >
        <CopyButton
          value={revealed.value}
          variant="outline"
          size="icon"
          aria-label="Copy value"
          toastMessage="Value copied to clipboard"
        />
      </div>

      <p class="text-xs text-muted-foreground">
        An agent reads this with
        <code class="font-mono">{agentUsage(revealed.secret.slug)}</code>. Every such read is
        recorded in the MCP audit log against the host that made it.
      </p>

      <Dialog.Footer>
        <Button onclick={() => (revealed = null)}>Done</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<!-- Revoke confirmation -->
<Dialog.Root
  open={deleteTarget !== null}
  onOpenChange={(next) => {
    if (!next && !$deleteMutation.isPending) deleteTarget = null;
  }}
>
  <Dialog.Content class="sm:max-w-md">
    {#if deleteTarget}
      <Dialog.Header>
        <Dialog.Title>Revoke {deleteTarget.slug}?</Dialog.Title>
        <Dialog.Description>
          Agents are refused from their next read on — nothing is cached on any host. The slug
          stays reserved, so adding it again later revives the entry with a fresh value.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button
          variant="outline"
          onclick={() => (deleteTarget = null)}
          disabled={$deleteMutation.isPending}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={$deleteMutation.isPending}
          onclick={() => deleteTarget && $deleteMutation.mutate(deleteTarget)}
        >
          {$deleteMutation.isPending ? "Revoking…" : "Revoke"}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
