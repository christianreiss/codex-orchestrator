<script lang="ts">
  /**
   * The four numbers that bound the pool. They are saved as one payload because
   * they only make sense together: the max TTL is the ceiling an agent's request
   * is clamped to, the default is what the guidance recommends, and the quota is
   * what the per-file cap is spent against. The server refuses an incoherent set.
   */
  import { toast } from "svelte-sonner";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { Section } from "$lib/components/page";
  import { formatBytes } from "$lib/utils/format";
  import { formatDuration, transferLimitsMutation, type TransferState } from "$lib/api/transfers";

  // Named `moduleState`, not `state`: a local called `state` shadows the `$state` rune.
  type Props = { moduleState: TransferState | undefined; canManage: boolean };
  let { moduleState, canManage }: Props = $props();

  const mutation = transferLimitsMutation({
    onSuccess: () => toast.success("Limits saved"),
    onError: (err) => toast.error(err.message),
  });

  // Minutes and MiB in the inputs, seconds and bytes on the wire.
  let defaultTtlMinutes = $state(60);
  let maxTtlMinutes = $state(1440);
  let maxFileMib = $state(0);
  let quotaMib = $state(0);
  let initialized = false;

  $effect(() => {
    if (!moduleState || initialized) return;
    defaultTtlMinutes = Math.round(moduleState.default_ttl_seconds / 60);
    maxTtlMinutes = Math.round(moduleState.max_ttl_seconds / 60);
    maxFileMib = moduleState.max_file_bytes / 1024 / 1024;
    quotaMib = moduleState.quota_bytes / 1024 / 1024;
    initialized = true;
  });

  function save() {
    $mutation.mutate({
      default_ttl_seconds: Number(defaultTtlMinutes) * 60,
      max_ttl_seconds: Number(maxTtlMinutes) * 60,
      max_file_bytes: Number(maxFileMib) * 1024 * 1024,
      quota_bytes: Number(quotaMib) * 1024 * 1024,
    });
  }

  const usedBytes = $derived(moduleState?.used_bytes ?? 0);
  const quotaBytes = $derived(moduleState?.quota_bytes ?? 0);
  const usedPercent = $derived(quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0);
  const meterTone = $derived(usedPercent >= 90 ? "bg-destructive" : usedPercent >= 80 ? "bg-warning" : "bg-primary");
</script>

<Section
  id="transfer-limits"
  title="Limits and usage"
  description="Every upload carries a TTL. The fleet clamps it to the maximum below and reports the deadline it actually granted. The default is what the guidance recommends, not a fallback."
>
  <div class="space-y-1.5">
    <div class="flex items-baseline justify-between text-body-sm">
      <span class="text-muted-foreground">
        {formatBytes(usedBytes)} {quotaBytes > 0 ? `of ${formatBytes(quotaBytes)} in use` : "in use · unlimited quota"}
        {#if moduleState}· {moduleState.live_count} file{moduleState.live_count === 1 ? "" : "s"} held{/if}
      </span>
      {#if quotaBytes > 0}<span class="tabular-nums text-muted-foreground">{usedPercent}%</span>{/if}
    </div>
    {#if quotaBytes > 0}
      <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div class={`h-full rounded-full transition-all ${meterTone}`} style={`width: ${usedPercent}%`}></div>
      </div>
    {/if}
    {#if quotaBytes > 0 && usedPercent >= 80}
      <p class="text-caption text-warning-foreground">Uploads are refused once the pool is full. Delete unneeded files or raise the quota. Changing the maximum TTL affects new uploads only.</p>
    {/if}
  </div>

  <div class="mt-4 grid gap-3 sm:grid-cols-2">
    <div class="space-y-1">
      <Label for="transfer-default-ttl">Default TTL (minutes)</Label>
      <Input id="transfer-default-ttl" type="number" min="1" bind:value={defaultTtlMinutes} disabled={!canManage} />
      <p class="text-caption text-muted-foreground">{formatDuration(Number(defaultTtlMinutes) * 60)}</p>
    </div>
    <div class="space-y-1">
      <Label for="transfer-max-ttl">Maximum TTL (minutes)</Label>
      <Input id="transfer-max-ttl" type="number" min="1" max="10080" bind:value={maxTtlMinutes} disabled={!canManage} />
      <p class="text-caption text-muted-foreground">{formatDuration(Number(maxTtlMinutes) * 60)} · the ceiling every request is clamped to</p>
    </div>
    <div class="space-y-1">
      <Label for="transfer-max-file">Maximum file size (MiB)</Label>
      <Input id="transfer-max-file" type="number" min="0" step="any" bind:value={maxFileMib} disabled={!canManage} />
      <p class="text-caption text-muted-foreground">0 means unlimited; binary transfers have no fixed file-size cap.</p>
    </div>
    <div class="space-y-1">
      <Label for="transfer-quota">Pool quota (MiB)</Label>
      <Input id="transfer-quota" type="number" min="0" step="any" bind:value={quotaMib} disabled={!canManage} />
      <p class="text-caption text-muted-foreground">0 means unlimited. Usage includes reserved upload sizes.</p>
    </div>
  </div>

  <div class="mt-3 flex justify-end">
    <Button size="sm" onclick={save} disabled={!canManage || $mutation.isPending}>{$mutation.isPending ? "Saving…" : "Save limits"}</Button>
  </div>
</Section>
