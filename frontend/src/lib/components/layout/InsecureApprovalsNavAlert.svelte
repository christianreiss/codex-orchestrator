<script lang="ts">
  import { base } from "$app/paths";
  import { cn } from "$lib/utils/cn";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import { insecureApprovalsPendingQuery } from "$lib/api/overview";

  /**
   * Alerting navigation row for hosts waiting on an insecure-window approval.
   * Rendered at the top of the desktop rail and the mobile menu sheet so the
   * alert is visible from every console page, not only the Overview. Renders
   * nothing while no approval is pending and the check succeeds.
   */
  type Props = {
    variant?: "rail" | "sheet";
    onnavigate?: () => void;
  };
  let { variant = "rail", onnavigate }: Props = $props();

  const pending = insecureApprovalsPendingQuery();
  const pendingCount = $derived($pending.data?.requests?.length ?? 0);
  const pendingError = $derived($pending.isError);

  const rowClass = $derived(
    cn(
      "flex w-full items-center gap-2.5 rounded-md border text-left font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
      variant === "sheet" ? "min-h-14 px-3 py-2 text-sm" : "h-8 px-2.5 text-[13px]",
    ),
  );
</script>

{#if pendingError}
  <button
    type="button"
    class={cn(rowClass, "border-destructive/40 bg-destructive-muted text-destructive-muted-foreground hover:bg-destructive-muted/80")}
    onclick={() => $pending.refetch()}
    title="The insecure-approvals check failed, so hosts waiting on approval may not be shown. Click to retry."
  >
    <ShieldAlert class="h-4 w-4 shrink-0" />
    <span class="truncate">Approvals check failed</span>
    <span class="ml-auto text-[11px] font-normal">Retry</span>
  </button>
{:else if pendingCount > 0}
  <a
    href={`${base}/hosts?insecure=1`}
    class={cn(rowClass, "border-warning/30 bg-warning-muted text-warning-muted-foreground hover:bg-warning-muted/80")}
    aria-label={pendingCount === 1 ? "1 host waiting for insecure approval" : `${pendingCount} hosts waiting for insecure approval`}
    title="Review insecure-window approvals"
    onclick={() => onnavigate?.()}
  >
    <ShieldAlert class="h-4 w-4 shrink-0" />
    <span class="truncate">Insecure approvals</span>
    <span class="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-warning px-1.5 text-[11px] font-semibold tabular-nums text-warning-foreground">{pendingCount}</span>
  </a>
{/if}
