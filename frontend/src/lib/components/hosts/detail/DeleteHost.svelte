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

  async function remove(): Promise<void> {
    try {
      await $mutation.mutateAsync({ id });
      open = false;
      toast.success("Host deleted");
      void goto(`${base}/hosts`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }
</script>

<Section title="Delete host" description="Permanently removes this host from the fleet. This cannot be undone." danger>
  <Button variant="destructive" onclick={() => (open = true)}><Trash2 class="h-4 w-4" /> Delete host</Button>
</Section>

<ConfirmDialog
  bind:open
  title="Delete host?"
  description={`Permanently remove ${fqdn} from the fleet. This cannot be undone.`}
  confirmLabel="Delete"
  destructive
  busy={$mutation.isPending}
  onConfirm={remove}
/>
