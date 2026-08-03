<script lang="ts">
  import { base } from "$app/paths";
  import { Button } from "$lib/components/ui/button";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import AlertBanner from "$lib/components/dashboard/AlertBanner.svelte";
  import { insecureApprovalsPendingQuery } from "$lib/api/overview";

  const pending = insecureApprovalsPendingQuery();

  const pendingCount = $derived($pending.data?.requests?.length ?? 0);
  const pendingError = $derived($pending.isError);
</script>

{#if pendingCount > 0 || pendingError}
  <div class="flex flex-col gap-3">
    {#if pendingError}
      <AlertBanner
        variant="destructive"
        title="Could not check insecure approvals"
        description="The insecure-approvals check failed, so hosts waiting on approval may not be shown."
      >
        {#snippet icon()}
          <ShieldAlert class="h-4 w-4" />
        {/snippet}
        {#snippet actions()}
          <Button size="sm" variant="outline" onclick={() => $pending.refetch()}>Retry</Button>
        {/snippet}
      </AlertBanner>
    {:else if pendingCount > 0}
      <AlertBanner
        variant="warning"
        title="Insecure approvals waiting"
        description={pendingCount === 1
          ? "1 host is waiting for an insecure-window approval."
          : `${pendingCount} hosts are waiting for insecure-window approvals.`}
      >
        {#snippet icon()}
          <ShieldAlert class="h-4 w-4" />
        {/snippet}
        {#snippet actions()}
          <Button href={`${base}/hosts?insecure=1`} size="sm" variant="outline">Review</Button>
        {/snippet}
      </AlertBanner>
    {/if}
  </div>
{/if}
