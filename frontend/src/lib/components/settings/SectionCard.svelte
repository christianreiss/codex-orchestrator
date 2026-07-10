<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Card from "$lib/components/ui/card";
  import SaveIndicator from "./SaveIndicator.svelte";

  type Props = {
    id: string;
    title: string;
    description?: string;
    headerAction?: Snippet;
    children?: Snippet;
    /** "idle" | "saving" | "saved" | "error" */
    status?: "idle" | "saving" | "saved" | "error";
    savedAt?: Date | string | null;
    error?: string | null;
  };

  let {
    id,
    title,
    description,
    headerAction,
    children,
    status = "idle",
    savedAt = null,
    error = null,
  }: Props = $props();
</script>

<section {id} class="scroll-mt-24">
  <Card.Root>
    <Card.Header class="flex flex-row items-start justify-between gap-3 space-y-0 p-4 pb-3">
      <div class="min-w-0">
        <Card.Title class="text-base font-semibold tracking-tight">{title}</Card.Title>
        {#if description}
          <Card.Description class="mt-0.5 text-sm leading-normal">
            {description}
          </Card.Description>
        {/if}
      </div>
      {#if headerAction}
        <div class="flex shrink-0 items-center gap-2">{@render headerAction()}</div>
      {/if}
    </Card.Header>
    <Card.Content class="space-y-3 px-4 pb-4 pt-0">
      {@render children?.()}
    </Card.Content>
    {#if status !== "idle" || savedAt || error}
      <Card.Footer class="flex items-center justify-between gap-2 px-4 pb-3 pt-0">
        <SaveIndicator {status} {savedAt} {error} />
      </Card.Footer>
    {/if}
  </Card.Root>
</section>
