<script lang="ts">
  import { onMount } from "svelte";
  import { base } from "$app/paths";
  import { Button } from "$lib/components/ui/button";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Rocket from "@lucide/svelte/icons/rocket";
  import AlertBanner from "$lib/components/dashboard/AlertBanner.svelte";
  import UpgradeModal from "$lib/components/dashboard/UpgradeModal.svelte";
  import {
    insecureApprovalsPendingQuery,
    outdatedClientVersions,
    releaseVersion,
    versionsCheckMutation,
    type AvailableClientRelease,
    type VersionCount,
    type VersionsCheckResponse,
  } from "$lib/api/overview";

  type Props = {
    reportedVersions?: VersionCount[];
  };
  let { reportedVersions = [] }: Props = $props();

  const pending = insecureApprovalsPendingQuery();
  const versions = versionsCheckMutation();

  let upgradeOpen = $state(false);
  let probed = $state(false);

  onMount(() => {
    // Fire the version probe once on mount; it's a real network call, so we
    // don't want it to fire on every focus or invalidation.
    $versions.mutate(undefined, {
      onSettled: () => {
        probed = true;
      },
    });
  });

  const versionData = $derived(($versions.data as VersionsCheckResponse | undefined) ?? null);
  const availableVersion = $derived(releaseVersion(versionData?.available_client));
  const availableUrl = $derived(
    typeof versionData?.available_client === "object"
      ? ((versionData.available_client as AvailableClientRelease | null)?.url ?? null)
      : null,
  );
  const outdatedVersions = $derived(outdatedClientVersions(availableVersion, reportedVersions));
  const outdatedHostCount = $derived(outdatedVersions.reduce((sum, item) => sum + item.count, 0));
  const upgradeAvailable = $derived(probed && outdatedHostCount > 0);

  const pendingCount = $derived($pending.data?.requests?.length ?? 0);
  const pendingError = $derived($pending.isError);
</script>

{#if pendingCount > 0 || upgradeAvailable || pendingError}
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
    {#if upgradeAvailable}
      <AlertBanner
        variant="info"
        title="Codex CLI update available"
        description={`Codex CLI ${availableVersion} is the latest release; ${outdatedHostCount} ${outdatedHostCount === 1 ? "host reports" : "hosts report"} an older version.`}
      >
        {#snippet icon()}
          <Rocket class="h-4 w-4" />
        {/snippet}
        {#snippet actions()}
          <Button size="sm" variant="outline" onclick={() => (upgradeOpen = true)}>View</Button>
        {/snippet}
      </AlertBanner>
    {/if}
  </div>
{/if}

<UpgradeModal
  bind:open={upgradeOpen}
  availableVersion={availableVersion}
  releaseUrl={availableUrl}
  {outdatedVersions}
  notes={null}
/>
