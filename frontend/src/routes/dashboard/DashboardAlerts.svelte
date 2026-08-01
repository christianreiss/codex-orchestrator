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
    releaseVersion,
    versionsCheckMutation,
    type VersionsCheckResponse,
  } from "$lib/api/overview";

  type Props = {
    currentVersion?: string | null;
  };
  let { currentVersion = null }: Props = $props();

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
  const installedVersion = $derived(
    currentVersion ??
      versionData?.versions?.client_version ??
      versionData?.versions?.cdx_version ??
      null,
  );

  function isNewer(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    if (a === b) return false;
    // Lexicographic on semver-ish strings is good enough for "is it different & newer".
    // Strip leading 'v' and compare numeric segments where possible.
    const aClean = a.replace(/^v/, "").split(/[.\-]/).map((s) => parseInt(s, 10));
    const bClean = b.replace(/^v/, "").split(/[.\-]/).map((s) => parseInt(s, 10));
    const len = Math.max(aClean.length, bClean.length);
    for (let i = 0; i < len; i++) {
      const an = Number.isFinite(aClean[i]) ? aClean[i] : 0;
      const bn = Number.isFinite(bClean[i]) ? bClean[i] : 0;
      if (an > bn) return true;
      if (an < bn) return false;
    }
    return false;
  }

  const upgradeAvailable = $derived(
    probed && availableVersion !== null && isNewer(availableVersion, installedVersion),
  );

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
        title="Update available"
        description={`Codex orchestrator ${availableVersion} is ready (you have ${installedVersion ?? "an older version"}).`}
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
  currentVersion={installedVersion}
  availableVersion={availableVersion}
  notes={null}
/>
