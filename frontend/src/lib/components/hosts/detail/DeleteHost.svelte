<script lang="ts">
  /** Delete host: last on the page, in its own danger section. */
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { createDeleteHostMutation } from "$lib/api/hosts";

  type Props = { id: string; fqdn: string };
  let { id, fqdn }: Props = $props();

  const mutation = createDeleteHostMutation(useQueryClient());
  let open = $state(false);
  let error = $state<string | null>(null);

  async function remove(): Promise<void> {
    error = null;
    try {
      await $mutation.mutateAsync({ id });
      open = false;
      toast.success(`Host ${fqdn} deleted`);
      void goto(`${base}/hosts`);
    } catch (err) {
      // Shown in the dialog beside the action, not only as a toast; the page stays on the host.
      error = `Could not delete ${fqdn}: ${(err instanceof Error && err.message) || "the server returned no reason"}.`;
    }
  }
</script>

<Section title="Delete host" description="Permanently removes this host from the fleet. This cannot be undone." danger>
  <Button variant="destructive" onclick={() => { error = null; open = true; }}><Trash2 class="h-4 w-4" /> Delete host</Button>
</Section>

<ConfirmDialog
  bind:open
  title="Delete host?"
  description="Removes the host and its stored auth digests from the fleet. A machine that already ran the installer loses access. This cannot be undone."
  confirmLabel="Delete host"
  busyLabel="Deleting…"
  destructive
  busy={$mutation.isPending}
  requireText={fqdn}
  requireTextLabel="Type the FQDN to confirm"
  {error}
  onConfirm={remove}
>
  <div class="rounded-md border border-destructive/40 px-3 py-2">
    <p class="text-caption text-muted-foreground">Host to delete</p>
    <p class="break-all font-mono text-body font-semibold">{fqdn}</p>
  </div>
</ConfirmDialog>
