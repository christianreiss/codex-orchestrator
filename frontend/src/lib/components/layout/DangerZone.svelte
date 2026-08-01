<script lang="ts">
  /**
   * Isolated container for irreversible actions — the destructive-isolation
   * rule: destructive controls never share a row/card with benign ones.
   */
  import type { Snippet } from "svelte";
  import * as Card from "$lib/components/ui/card";

  type Props = {
    title?: string;
    description?: string;
    children: Snippet;
  };
  let { title = "Danger zone", description, children }: Props = $props();
</script>

<Card.Root class="border-destructive/30">
  <Card.Header>
    <Card.Title class="text-destructive">{title}</Card.Title>
    {#if description}
      <Card.Description>{description}</Card.Description>
    {/if}
  </Card.Header>
  <Card.Content class="flex flex-wrap items-center gap-2">
    {@render children()}
  </Card.Content>
</Card.Root>
