<script lang="ts">
  /** The destructive last block of the Access page: collapsed until asked for. */
  import { toast } from "svelte-sonner";
  import Trash from "@lucide/svelte/icons/trash";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Section } from "$lib/components/page";
  import WipeUsersDialog from "./WipeUsersDialog.svelte";
  import { createUsersQuery, createWipeUsersMutation } from "$lib/api/users";
  import { authStore } from "$lib/stores/auth";

  const canManage = $derived($authStore.can("users.manage"));
  const usersQuery = createUsersQuery();
  const wipeMut = createWipeUsersMutation();
  const total = $derived($usersQuery.data?.length ?? 0);

  let expanded = $state(false);
  let wipeOpen = $state(false);

  async function confirmWipe() {
    try {
      await $wipeMut.mutateAsync();
      toast.success("All users wiped");
      wipeOpen = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Wipe failed");
    }
  }
</script>

{#if canManage}
  <Collapsible.Root bind:open={expanded}>
    <Section id="danger-zone" danger title="Danger zone" description="Irreversible actions on people.">
      {#snippet actions()}
        <Collapsible.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="sm">
              {expanded ? "Hide" : "Show"}
              <ChevronDown class={expanded ? "h-4 w-4 rotate-180" : "h-4 w-4"} />
            </Button>
          {/snippet}
        </Collapsible.Trigger>
      {/snippet}
      <Collapsible.Content>
        <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p class="max-w-xl text-body-sm text-muted-foreground">Permanently delete every admin account, session and password reset. This cannot be undone.</p>
          <Button variant="destructive" onclick={() => (wipeOpen = true)} disabled={total === 0}>
            <Trash class="h-4 w-4" />Wipe all users
          </Button>
        </div>
      </Collapsible.Content>
    </Section>
  </Collapsible.Root>

  <WipeUsersDialog open={wipeOpen} onOpenChange={(o) => (wipeOpen = o)} submitting={$wipeMut.isPending} onConfirm={confirmWipe} />
{/if}
