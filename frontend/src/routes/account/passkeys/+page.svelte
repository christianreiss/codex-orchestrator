<script lang="ts">
  import { toast } from "svelte-sonner";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { format } from "date-fns";

  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Table from "$lib/components/ui/table";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";

  import { ApiError } from "$lib/api/client";
  import {
    accountKeys,
    deletePasskey,
    listPasskeys,
    passkeyRegister,
    passkeyRegisterOptions,
    renamePasskey,
  } from "$lib/api/account";
  import type { Passkey } from "$lib/api/types";
  import { registerPasskey } from "$lib/components/account/webauthn";
  import PasskeyNameDialog from "$lib/components/account/PasskeyNameDialog.svelte";
  import { relativeTime } from "$lib/utils/format";

  import Fingerprint from "@lucide/svelte/icons/fingerprint";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";

  const qc = useQueryClient();

  const passkeysQuery = createQuery<Passkey[]>({
    queryKey: accountKeys.passkeys,
    queryFn: () => listPasskeys(),
  });

  let webauthnSupported = $state(true);
  $effect(() => {
    if (typeof window !== "undefined") {
      webauthnSupported = typeof window.PublicKeyCredential !== "undefined";
    }
  });

  // Registration flow state
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
      const result = await passkeyRegister(attestation as unknown as Record<string, unknown>);
      pendingPasskey = result.passkey;
      nameDialogOpen = true;
      // Optimistically prime the cache
      void qc.invalidateQueries({ queryKey: accountKeys.passkeys });
      toast.success("Passkey registered. Give it a name.");
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else if (err instanceof Error) {
        // DOMException: NotAllowedError comes through as a normal Error here.
        if (err.name === "NotAllowedError" || /cancel/i.test(err.message)) {
          toast.warning("Registration was cancelled.");
        } else {
          toast.error(err.message);
        }
      } else {
        toast.error("Registration failed.");
      }
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
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else {
        toast.error("Could not save name.");
      }
    } finally {
      nameSubmitting = false;
    }
  }

  // Inline rename state — keyed by passkey id
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
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error("Rename failed.");
    } finally {
      inlineSubmitting = false;
    }
  }

  // Delete confirm
  let deleteTarget = $state<Passkey | null>(null);
  let deleteSubmitting = $state(false);

  async function confirmDelete() {
    if (!deleteTarget) return;
    deleteSubmitting = true;
    try {
      await deletePasskey(deleteTarget.id);
      toast.success("Passkey removed.");
      deleteTarget = null;
      await qc.invalidateQueries({ queryKey: accountKeys.passkeys });
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error("Delete failed.");
    } finally {
      deleteSubmitting = false;
    }
  }

  function absoluteDate(input: string | null | undefined): string {
    if (!input) return "";
    try {
      const d = new Date(input);
      if (Number.isNaN(d.getTime())) return input;
      return format(d, "yyyy-MM-dd HH:mm:ss");
    } catch {
      return input;
    }
  }
</script>

<PageHeader title="Passkeys" subtitle="Manage WebAuthn credentials">
  {#snippet actions()}
    <Button onclick={startRegistration} disabled={registering || !webauthnSupported}>
      <Fingerprint class="h-4 w-4" />
      {registering ? "Registering…" : "Register passkey"}
    </Button>
  {/snippet}
</PageHeader>

{#if !webauthnSupported}
  <Alert variant="warning" class="mb-6">
    <AlertDescription>
      This browser does not expose the WebAuthn API. Use a recent version of Chrome,
      Firefox, Safari, or Edge to register a passkey.
    </AlertDescription>
  </Alert>
{/if}

<Card.Root>
  <Card.Header>
    <Card.Title>Registered credentials</Card.Title>
    <Card.Description>
      Passkeys let you sign in without a password, using a hardware authenticator or
      platform biometrics. Each device is shown below — click the pencil to rename.
    </Card.Description>
  </Card.Header>
  <Card.Content class="p-0">
    {#if $passkeysQuery.isLoading}
      <div class="px-6 py-10 text-center text-sm text-muted-foreground">Loading…</div>
    {:else if $passkeysQuery.isError}
      <div class="px-6 py-10 text-center text-sm text-destructive">
        {$passkeysQuery.error instanceof Error
          ? $passkeysQuery.error.message
          : "Failed to load passkeys."}
      </div>
    {:else if !$passkeysQuery.data || $passkeysQuery.data.length === 0}
      <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <Fingerprint class="h-8 w-8 text-muted-foreground" />
        <p class="text-sm text-muted-foreground">No passkeys registered yet.</p>
        <Button onclick={startRegistration} disabled={registering || !webauthnSupported}>
          Register your first passkey
        </Button>
      </div>
    {:else}
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Created</Table.Head>
            <Table.Head>Last used</Table.Head>
            <Table.Head class="w-32 text-right">Actions</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each $passkeysQuery.data as p (p.id)}
            <Table.Row>
              <Table.Cell>
                {#if editingId === p.id}
                  <form
                    class="flex items-center gap-2"
                    onsubmit={(e) => {
                      e.preventDefault();
                      void commitEdit();
                    }}
                  >
                    <Input
                      bind:value={editingValue}
                      class="h-8"
                      autofocus
                      maxlength={255}
                      disabled={inlineSubmitting}
                    />
                    <Button
                      type="submit"
                      size="icon"
                      class="h-8 w-8"
                      disabled={inlineSubmitting}
                      aria-label="Save"
                    >
                      <Check class="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      class="h-8 w-8"
                      onclick={cancelEdit}
                      disabled={inlineSubmitting}
                      aria-label="Cancel"
                    >
                      <X class="h-4 w-4" />
                    </Button>
                  </form>
                {:else}
                  <div class="flex items-center gap-2">
                    <span class="font-medium">{p.name || "Unnamed passkey"}</span>
                    <button
                      type="button"
                      class="text-muted-foreground opacity-60 transition hover:text-foreground hover:opacity-100"
                      aria-label="Rename"
                      onclick={() => startEdit(p)}
                    >
                      <Pencil class="h-3.5 w-3.5" />
                    </button>
                  </div>
                {/if}
              </Table.Cell>
              <Table.Cell>
                {#if p.created_at}
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger class="text-sm text-muted-foreground">
                        {relativeTime(p.created_at)}
                      </Tooltip.Trigger>
                      <Tooltip.Content>{absoluteDate(p.created_at)}</Tooltip.Content>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                {:else}
                  <span class="text-sm text-muted-foreground">—</span>
                {/if}
              </Table.Cell>
              <Table.Cell>
                {#if p.last_used_at}
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger class="text-sm text-muted-foreground">
                        {relativeTime(p.last_used_at)}
                      </Tooltip.Trigger>
                      <Tooltip.Content>{absoluteDate(p.last_used_at)}</Tooltip.Content>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                {:else}
                  <span class="text-sm text-muted-foreground">Never</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right">
                <Button
                  size="icon"
                  variant="ghost"
                  class="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete"
                  onclick={() => (deleteTarget = p)}
                  disabled={editingId !== null}
                >
                  <Trash2 class="h-4 w-4" />
                </Button>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    {/if}
  </Card.Content>
</Card.Root>

<!-- Name the freshly registered passkey -->
<PasskeyNameDialog
  bind:open={nameDialogOpen}
  title="Name your new passkey"
  description="The credential is now registered. Give it a label so you can recognise it later."
  submitLabel="Save name"
  submitting={nameSubmitting}
  onSubmit={onNamePendingPasskey}
  onCancel={() => {
    // Leave it in the list — backend stored it; user can rename later inline.
    pendingPasskey = null;
  }}
/>

<!-- Delete confirmation -->
<Dialog.Root
  open={deleteTarget !== null}
  onOpenChange={(o) => {
    if (!o) deleteTarget = null;
  }}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Remove passkey?</Dialog.Title>
      <Dialog.Description>
        {#if deleteTarget}
          <strong>{deleteTarget.name || "This passkey"}</strong> will be revoked and can no
          longer be used to sign in. This cannot be undone.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (deleteTarget = null)} disabled={deleteSubmitting}>
        Cancel
      </Button>
      <Button variant="destructive" onclick={confirmDelete} disabled={deleteSubmitting}>
        {deleteSubmitting ? "Removing…" : "Remove passkey"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
