<script lang="ts" module>
  import type { ProviderAccount } from "$lib/api/accounts";
  export type AccountDialog =
    | { kind: "add" }
    | { kind: "replace" | "rename" | "remove" | "quota"; account: ProviderAccount };
</script>

<script lang="ts">
  /** Every account dialog in one place: rename, add / replace credentials (SeedAuthPanel), remove. */
  import QuotaPolicyEditor from "$lib/components/settings/QuotaPolicyEditor.svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import SeedAuthPanel from "$lib/components/setup/SeedAuthPanel.svelte";
  import { ENGINES, ENGINE_META, type Engine } from "$lib/constants/engines";

  type Props = {
    dialog: AccountDialog | null;
    /** Engine the list is scoped to, or "all". Narrows what an added account may be. */
    scope: Engine | "all";
    busy: boolean;
    onClose: () => void;
    onRename: (account: ProviderAccount, label: string) => void;
    onRemove: (account: ProviderAccount) => void;
    onStored: () => void;
  };
  let { dialog, scope, busy, onClose, onRename, onRemove, onStored }: Props = $props();

  let label = $state("");
  let renameValue = $state("");
  // Reset the draft whenever a different dialog opens.
  $effect(() => {
    if (dialog?.kind === "rename") renameValue = dialog.account.label;
    if (dialog?.kind === "add") label = "";
  });

  const credentials = $derived(dialog && (dialog.kind === "add" || dialog.kind === "replace") ? dialog : null);
  const target = $derived(dialog && dialog.kind !== "add" ? dialog.account : null);
  const title = $derived(
    target && dialog?.kind === "replace" ? `Replace ${target.label} credentials`
      : scope !== "all" ? `Add ${ENGINE_META[scope].account} account` : "Add account",
  );
  const removeOpen = $derived(dialog?.kind === "remove");
</script>

<Dialog.Root open={credentials !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>Credentials are verified before they can be assigned to clients.</Dialog.Description>
    </Dialog.Header>
    {#if credentials && credentials.kind === "add"}
      <div class="space-y-2"><Label for="account-label">Account name</Label><Input id="account-label" bind:value={label} maxlength={191} placeholder="Account name (optional)" /></div>
    {/if}
    {#key credentials}
      {#if credentials}
        <SeedAuthPanel
          allowedEngines={target ? [target.engine] : scope !== "all" ? [scope] : [...ENGINES]}
          defaultEngine={target?.engine ?? (scope === "all" ? "codex" : scope)}
          accountId={target?.id}
          accountLabel={target ? undefined : label.trim() || undefined}
          accountManagement
          {onStored}
        />
      {/if}
    {/key}
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={dialog?.kind === "rename"} onOpenChange={(open) => { if (!open) onClose(); }}>
  <Dialog.Content class="sm:max-w-md">
    <form onsubmit={(event) => { event.preventDefault(); if (dialog?.kind === "rename" && renameValue.trim()) onRename(dialog.account, renameValue.trim()); }}>
      <Dialog.Header><Dialog.Title>Rename account</Dialog.Title><Dialog.Description>Only the display name changes; credentials and sessions are untouched.</Dialog.Description></Dialog.Header>
      <div class="my-4"><Input aria-label="Account name" bind:value={renameValue} maxlength={191} required /></div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !renameValue.trim()}>Save</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<ConfirmDialog
  open={removeOpen}
  title={target ? `Remove “${target.label}”?` : "Remove account?"}
  description="New assignments stop immediately. Stored credentials are retired after active sessions finish."
  confirmLabel="Remove"
  destructive
  {busy}
  onConfirm={() => { if (dialog?.kind === "remove") onRemove(dialog.account); }}
  onClose={onClose}
/>

<Dialog.Root open={dialog?.kind === "quota"} onOpenChange={(open) => { if (!open) onClose(); }}>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
    <Dialog.Header><Dialog.Title>{target?.label} quota policy</Dialog.Title><Dialog.Description>Account overrides for warnings, reset recovery and PayG.</Dialog.Description></Dialog.Header>
    {#if dialog?.kind === "quota"}
      {#key dialog.account.id}<QuotaPolicyEditor engine={dialog.account.engine} accountId={dialog.account.id} />{/key}
    {/if}
  </Dialog.Content>
</Dialog.Root>
