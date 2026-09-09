<script lang="ts">
  /**
   * The audit trail for one transfer.
   *
   * This is the page's reason for existing as much as the table is. The pool has
   * no addressing — any agent that knows an id can fetch a file, and nobody is
   * notified of an upload — so the only account anyone can give of who has a
   * copy is this list.
   */
  import * as Sheet from "$lib/components/ui/sheet";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { relativeTime, formatBytes } from "$lib/utils/format";
  import {
    transferActionLabel,
    transferEventsQuery,
    type TransferRow,
  } from "$lib/api/transfers";

  type Props = { row: TransferRow | null; onOpenChange: (open: boolean) => void };
  let { row, onOpenChange }: Props = $props();

  const query = transferEventsQuery(() => row?.id ?? null);
  const events = $derived($query.data?.events ?? []);
</script>

<Sheet.Root open={row !== null} {onOpenChange}>
  <Sheet.Content side="right" class="w-full sm:max-w-lg">
    {#if row}
      <Sheet.Header>
        <Sheet.Title class="break-all">{row.name}</Sheet.Title>
        <Sheet.Description>
          {formatBytes(row.size_bytes)}
          {#if row.mime_type}· {row.mime_type}{/if}
          · expires {relativeTime(row.expires_at)}
        </Sheet.Description>
      </Sheet.Header>

      <div class="mt-4 space-y-4">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt class="text-muted-foreground">Id</dt>
          <dd class="break-all font-mono">{row.id}</dd>

          <dt class="text-muted-foreground">Uploaded by</dt>
          <dd>
            {row.uploaded_by ?? "not stated"}
            <span class="text-muted-foreground">(asserted by the caller)</span>
          </dd>

          {#if row.uploaded_from}
            <dt class="text-muted-foreground">From</dt>
            <dd class="break-all font-mono">{row.uploaded_from}</dd>
          {/if}

          {#if row.content_sha256}
            <dt class="text-muted-foreground">sha256</dt>
            <dd class="break-all font-mono">{row.content_sha256}</dd>
          {/if}

          <dt class="text-muted-foreground">TTL asked for</dt>
          <dd>
            {row.requested_ttl_seconds ?? "—"}s
            {#if row.ttl_clamped}
              <Badge variant="warning" class="ml-1">clamped</Badge>
            {/if}
          </dd>

          {#if row.description}
            <dt class="text-muted-foreground">Description</dt>
            <dd>{row.description}</dd>
          {/if}
        </dl>

        <div>
          <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Trail
          </h3>
          {#if $query.isPending}
            <div class="space-y-2">
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </div>
          {:else if events.length === 0}
            <p class="text-xs text-muted-foreground">Nothing recorded yet.</p>
          {:else}
            <ol class="space-y-2">
              {#each events as event (event.id)}
                <li class="flex items-baseline justify-between gap-3 border-b border-border pb-2 text-xs">
                  <span>
                    {transferActionLabel(event)}
                    {#if event.detail}
                      <span class="text-muted-foreground">— {event.detail}</span>
                    {/if}
                  </span>
                  <span class="shrink-0 text-muted-foreground">{relativeTime(event.created_at)}</span>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
