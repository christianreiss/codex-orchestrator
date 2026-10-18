<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import { toast } from "svelte-sonner";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { format } from "date-fns";
  import * as Table from "$lib/components/ui/table";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { DataTable } from "$lib/components/page";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import { ApiError } from "$lib/api/client";
  import { accountKeys, deletePasskey, listPasskeys, passkeyRegister, passkeyRegisterOptions, renamePasskey } from "$lib/api/account";
  import type { Passkey } from "$lib/api/types";
  import { registerPasskey } from "$lib/components/account/webauthn";
  import PasskeyNameDialog from "$lib/components/account/PasskeyNameDialog.svelte";
  import Fingerprint from "@lucide/svelte/icons/fingerprint";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";

  const qc = useQueryClient();
  const passkeysQuery = createQuery<Passkey[]>({ queryKey: accountKeys.passkeys, queryFn: () => listPasskeys() });

  let webauthnSupported = $state(true);
  $effect(() => {
    if (typeof window !== "undefined") webauthnSupported = typeof window.PublicKeyCredential !== "undefined";
  });

  // Registration flow
  let registering = $state(false);
  let nameDialogOpen = $state(false);
  let pendingPasskey = $state<Passkey | null>(null);
  let nameSubmitting = $state(false);

  async function startRegistration() {
    if (registering) return;
    if (!webauthnSupported) {
      toast.error("This browser does not support passkeys.");
      return;
    }
    registering = true;
    try {
      const options = await passkeyRegisterOptions();
      const attestation = await registerPasskey(options);
      const result = await passkeyRegister({ response: attestation });
      pendingPasskey = result.passkey;
      nameDialogOpen = true;
      void qc.invalidateQueries({ queryKey: accountKeys.passkeys });
      toast.success("Passkey registered. Give it a name.");
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else if (err instanceof Error) {
        // DOMException: NotAllowedError comes through as a normal Error here.
        if (err.name === "NotAllowedError" || /cancel/i.test(err.message)) toast.warning("Registration was cancelled.");
        else toast.error(err.message);
      } else toast.error("Registration failed.");
    } finally {
      registering = false;
    }
  }

  async function onNamePendingPasskey(name: string) {
    if (!pendingPasskey) return;
    nameSubmitting = true;
    try {
      await renamePasskey(pendingPasskey.id, name);
      toast.success("Passkey saved.");
      nameDialogOpen = false;
      pendingPasskey = null;
      await qc.invalidateQueries({ queryKey: accountKeys.passkeys });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save name.");
    } finally {
      nameSubmitting = false;
    }
  }

  // Inline rename, keyed by passkey id
  let editingId = $state<number | null>(null);
  let editingValue = $state("");
  let inlineSubmitting = $state(false);

  function startEdit(p: Passkey) {
    editingId = p.id;
    editingValue = p.name;
  }
  function cancelEdit() {
    editingId = null;
    editingValue = "";
  }
  async function commitEdit() {
    if (editingId === null) return;
    const trimmed = editingValue.trim();
    if (!trimmed) {
      toast.error("Name is required.");
      return;
    }
    inlineSubmitting = true;
    try {
      await renamePasskey(editingId, trimmed);
      toast.success("Passkey renamed.");
      cancelEdit();
      await qc.invalidateQueries({ queryKey: accountKeys.passkeys });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Rename failed.");
    } finally {
      inlineSubmitting = false;
    }
  }

  // Removal
  let deleteTarget = $state<Passkey | null>(null);
  let deleteOpen = $state(false);
  let deleteSubmitting = $state(false);
  $effect(() => {
    if (!deleteOpen) deleteTarget = null;
  });

  async function confirmDelete() {
    if (!deleteTarget) return;
    deleteSubmitting = true;
    try {
      await deletePasskey(deleteTarget.id);
      toast.success("Passkey removed.");
      deleteOpen = false;
      await qc.invalidateQueries({ queryKey: accountKeys.passkeys });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      deleteSubmitting = false;
    }
  }

  /** Puts the cursor in the rename field the moment it appears. */
  function focusFirstInput(node: HTMLElement) {
    node.querySelector("input")?.focus();
  }

  function absoluteDate(input: string | null | undefined): string {
    if (!input) return "";
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? input : format(d, "yyyy-MM-dd HH:mm:ss");
  }
</script>

<div class="space-y-3">
  <div class="flex flex-wrap items-start justify-between gap-2">
    <p class="max-w-xl text-body-sm text-muted-foreground">
      Sign in without a password using a hardware key or device biometrics. Once you have a passkey, you must sign in with it.
    </p>
    <Button size="sm" variant="outline" onclick={startRegistration} disabled={registering || !webauthnSupported}>
      <Fingerprint class="h-4 w-4" />{registering ? "Registering…" : "Add passkey"}
    </Button>
  </div>

  {#if !webauthnSupported}
    <Alert variant="warning">
      <AlertDescription>This browser does not expose the WebAuthn API. Use a recent Chrome, Firefox, Safari or Edge to register a passkey.</AlertDescription>
    </Alert>
  {/if}

  <DataTable
    items={$passkeysQuery.data}
    loading={$passkeysQuery.isLoading}
    error={$passkeysQuery.isError ? ($passkeysQuery.error instanceof Error ? $passkeysQuery.error.message : "Failed to load passkeys.") : null}
    onRetry={() => $passkeysQuery.refetch()}
    key={(p) => p.id}
    caption="Registered passkeys"
    emptyTitle="No passkeys registered"
    emptyIcon={Fingerprint}
  >
    {#snippet head()}
      <Table.Head>Name</Table.Head>
      <Table.Head>Created</Table.Head>
      <Table.Head>Last used</Table.Head>
      <Table.Head class="w-12"><span class="sr-only">Actions</span></Table.Head>
    {/snippet}
    {#snippet row(p)}
      <Table.Row>
        <Table.Cell>
          {#if editingId === p.id}
            <form use:focusFirstInput class="flex items-center gap-2" onsubmit={(e) => { e.preventDefault(); void commitEdit(); }}>
              <Input bind:value={editingValue} aria-label="Passkey name" maxlength={255} disabled={inlineSubmitting} />
              <Button type="submit" size="icon" disabled={inlineSubmitting} aria-label="Save"><Check class="h-4 w-4" /></Button>
              <Button type="button" size="icon" variant="outline" onclick={cancelEdit} disabled={inlineSubmitting} aria-label="Cancel"><X class="h-4 w-4" /></Button>
            </form>
          {:else}
            <span class="font-medium">{p.name || "Unnamed passkey"}</span>
          {/if}
        </Table.Cell>
        <Table.Cell>
          {#if p.created_at}
            <Tooltip.Provider><Tooltip.Root>
              <Tooltip.Trigger class="text-body-sm text-muted-foreground"><Timestamp value={p.created_at} /></Tooltip.Trigger>
              <Tooltip.Content>{absoluteDate(p.created_at)}</Tooltip.Content>
            </Tooltip.Root></Tooltip.Provider>
          {:else}<span class="text-body-sm text-muted-foreground">—</span>{/if}
        </Table.Cell>
        <Table.Cell>
          {#if p.last_used_at}
            <Tooltip.Provider><Tooltip.Root>
              <Tooltip.Trigger class="text-body-sm text-muted-foreground"><Timestamp value={p.last_used_at} /></Tooltip.Trigger>
              <Tooltip.Content>{absoluteDate(p.last_used_at)}</Tooltip.Content>
            </Tooltip.Root></Tooltip.Provider>
          {:else}<span class="text-body-sm text-muted-foreground">Never</span>{/if}
        </Table.Cell>
        <Table.Cell class="text-right">
          <RowActions
            label={`Actions for ${p.name || "passkey"}`}
            actions={[
              { label: "Rename", icon: Pencil, onClick: () => startEdit(p), disabled: editingId !== null },
              { label: "Remove", icon: Trash2, destructive: true, onClick: () => { deleteTarget = p; deleteOpen = true; }, disabled: editingId !== null },
            ]}
          />
        </Table.Cell>
      </Table.Row>
    {/snippet}
  </DataTable>
</div>

<PasskeyNameDialog
  bind:open={nameDialogOpen}
  title="Name your new passkey"
  description="The credential is now registered. Give it a label so you can recognise it later."
  submitLabel="Save name"
  submitting={nameSubmitting}
  onSubmit={onNamePendingPasskey}
  onCancel={() => (pendingPasskey = null)}
/>

<ConfirmDialog
  bind:open={deleteOpen}
  title="Remove passkey?"
  description={`${deleteTarget?.name || "This passkey"} will be revoked and can no longer be used to sign in. This cannot be undone.`}
  confirmLabel="Remove passkey"
  destructive
  busy={deleteSubmitting}
  onConfirm={confirmDelete}
/>
