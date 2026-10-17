<script lang="ts">
  /** Header actions: one primary "Add host" (with Quick VM beside it) and a "More" menu for admin tasks. */
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Rocket from "@lucide/svelte/icons/rocket";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Button } from "$lib/components/ui/button";

  type Props = { onAdd: () => void; onQuickVm: () => void; onSeedAuth: () => void; onReviewAccess: () => void };
  let { onAdd, onQuickVm, onSeedAuth, onReviewAccess }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button {...props} variant="outline" aria-label="More host actions"><Ellipsis class="h-4 w-4" /> More</Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-60">
    <DropdownMenu.Item onclick={onSeedAuth}><KeyRound class="h-4 w-4" /> Seed canonical auth</DropdownMenu.Item>
    <DropdownMenu.Item onclick={onReviewAccess}><ShieldAlert class="h-4 w-4" /> Review temporary access</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<div class="inline-flex">
  <Button class="rounded-r-none" onclick={onAdd}><Plus class="h-4 w-4" /> Add host</Button>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} class="rounded-l-none border-l border-primary-foreground/25 px-2" aria-label="More ways to add a host">
          <ChevronDown class="h-4 w-4" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-56">
      <DropdownMenu.Item onclick={onAdd}><Plus class="h-4 w-4" /> Add host</DropdownMenu.Item>
      <DropdownMenu.Item onclick={onQuickVm}><Rocket class="h-4 w-4" /> Quick VM</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
