<script lang="ts">
  /**
   * The four numbers that bound the pool. They are one card rather than four
   * rows because they only make sense together: the max TTL is the ceiling an
   * agent's request is clamped to, the default is what the guidance recommends,
   * and the quota is what the per-file cap is spent against. The server refuses
   * an incoherent set, so this saves them as one payload rather than letting a
   * half-applied change through.
   */
  import { toast } from "svelte-sonner";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "$lib/components/settings/SectionCard.svelte";
  import { formatBytes } from "$lib/utils/format";
  import { formatDuration, transferLimitsMutation, type TransferState } from "$lib/api/transfers";

  // Named `moduleState`, not `state`: a local called `state` shadows the `$state`
  // rune and svelte-check reads every `$state(...)` below as a store subscription.
  type Props = { moduleState: TransferState | undefined; canManage: boolean };
  let { moduleState, canManage }: Props = $props();

  let lastSavedAt = $state<Date | null>(null);
  const mutation = transferLimitsMutation({
    onSuccess: () => {
      lastSavedAt = new Date();
      toast.success("Transfer limits saved");
    },
    onError: (err) => toast.error(err.message),
  });

  // Minutes and MiB in the inputs, seconds and bytes on the wire: an operator
  // setting a one-day ceiling should not have to type 86400.
  let defaultTtlMinutes = $state(60);
  let maxTtlMinutes = $state(1440);
  let maxFileMib = $state(8);
  let quotaMib = $state(2048);
  let initialized = false;

  $effect(() => {
    if (!moduleState || initialized) return;
    defaultTtlMinutes = Math.round(moduleState.default_ttl_seconds / 60);
    maxTtlMinutes = Math.round(moduleState.max_ttl_seconds / 60);
    maxFileMib = Math.round(moduleState.max_file_bytes / 1024 / 1024);
    quotaMib = Math.round(moduleState.quota_bytes / 1024 / 1024);
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

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });

  const usedBytes = $derived(moduleState?.used_bytes ?? 0);
  const quotaBytes = $derived(moduleState?.quota_bytes ?? 1);
  const usedPercent = $derived(Math.min(100, Math.round((usedBytes / Math.max(quotaBytes, 1)) * 100)));
  const meterTone = $derived(
    usedPercent >= 90 ? "bg-destructive" : usedPercent >= 80 ? "bg-warning" : "bg-primary",
  );
</script>

<SectionCard
  id="transfer-limits"
  title="Limits and usage"
  description="An agent must pass a TTL on every upload; the fleet clamps it to the maximum below and reports the deadline it actually granted. The default is what the guidance recommends, not a fallback for a missing value."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message}
>
  <div class="space-y-1.5">
    <div class="flex items-baseline justify-between text-xs">
      <span class="text-muted-foreground">
        {formatBytes(usedBytes)} of {formatBytes(quotaBytes)} in use
        {#if moduleState}
          · {moduleState.live_count} file{moduleState.live_count === 1 ? "" : "s"} held
        {/if}
      </span>
      <span class="tabular-nums text-muted-foreground">{usedPercent}%</span>
    </div>
    <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div class={`h-full rounded-full transition-all ${meterTone}`} style={`width: ${usedPercent}%`}></div>
    </div>
    {#if usedPercent >= 80}
      <p class="text-xs text-warning-foreground">
        Uploads are refused once the pool is full. Shortening the maximum TTL frees space on the next
        sweep without anyone having to delete anything.
      </p>
    {/if}
  </div>

  <div class="grid gap-3 sm:grid-cols-2">
    <div class="space-y-1">
      <Label for="transfer-default-ttl" class="text-xs">Default TTL (minutes)</Label>
      <Input
        id="transfer-default-ttl"
        type="number"
        min="1"
        bind:value={defaultTtlMinutes}
        disabled={!canManage}
      />
      <p class="text-xs text-muted-foreground">{formatDuration(Number(defaultTtlMinutes) * 60)}</p>
    </div>
    <div class="space-y-1">
      <Label for="transfer-max-ttl" class="text-xs">Maximum TTL (minutes)</Label>
      <Input
        id="transfer-max-ttl"
        type="number"
        min="1"
        max="10080"
        bind:value={maxTtlMinutes}
        disabled={!canManage}
      />
      <p class="text-xs text-muted-foreground">
        {formatDuration(Number(maxTtlMinutes) * 60)} · the ceiling every request is clamped to
      </p>
    </div>
    <div class="space-y-1">
      <Label for="transfer-max-file" class="text-xs">Maximum file size (MiB)</Label>
      <Input
        id="transfer-max-file"
        type="number"
        min="1"
        max="64"
        bind:value={maxFileMib}
        disabled={!canManage}
      />
    </div>
    <div class="space-y-1">
      <Label for="transfer-quota" class="text-xs">Pool quota (MiB)</Label>
      <Input
        id="transfer-quota"
        type="number"
        min="1"
        bind:value={quotaMib}
        disabled={!canManage}
      />
    </div>
  </div>

  <div class="flex justify-end">
    <Button size="sm" onclick={save} disabled={!canManage || $mutation.isPending}>
      {$mutation.isPending ? "Saving…" : "Save limits"}
    </Button>
  </div>
</SectionCard>
