<script lang="ts">
  import type { Snippet } from "svelte";
  import { formatDateTime, formatTime } from "$lib/utils/format";
  let { id, name, createdAt, operator = false, important = false, children, actions }: {
    id: string; name: string; createdAt: string; operator?: boolean; important?: boolean;
    children: Snippet; actions?: Snippet;
  } = $props();
</script>

<article {id} tabindex="-1" aria-label={`${important ? "Important message" : "Message"} from ${name}`}
  class="message-frame mx-auto my-6 w-full max-w-[75ch] min-w-0 text-body-sm focus-visible:ring-2 focus-visible:ring-ring {important ? 'rounded border border-destructive bg-destructive-muted p-3' : operator ? 'rounded bg-muted p-3' : ''}">
  <header class="mb-1 flex min-w-0 items-center gap-2">
    <span class="min-w-0 flex-1 break-words font-semibold">{name}{#if operator}<span class="ml-2 text-caption font-normal text-muted-foreground">Operator</span>{/if}</span>
    <time datetime={createdAt} title={formatDateTime(createdAt)} aria-label={formatDateTime(createdAt)} class="shrink-0 text-caption text-muted-foreground">{formatTime(createdAt)}</time>
  </header>
  {@render children()}
  {#if actions}<footer class="mt-3 flex flex-wrap items-center gap-3 text-caption text-muted-foreground">{@render actions()}</footer>{/if}
</article>
