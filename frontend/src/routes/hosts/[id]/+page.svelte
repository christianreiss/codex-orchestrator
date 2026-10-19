<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { hostDetailQuery, hostLastSeen, hostStatusKind } from "$lib/api/hosts";
  import { relativeTime } from "$lib/utils/format";
  import StatusPill from "$lib/components/hosts/StatusPill.svelte";
  import AccessSection from "$lib/components/hosts/detail/AccessSection.svelte";
  import AdvancedSection from "$lib/components/hosts/detail/AdvancedSection.svelte";
  import DeleteHost from "$lib/components/hosts/detail/DeleteHost.svelte";
  import EnginesSection from "$lib/components/hosts/detail/EnginesSection.svelte";
  import HostAttention from "$lib/components/hosts/detail/HostAttention.svelte";
  import InstallCommand from "$lib/components/hosts/detail/InstallCommand.svelte";

  const id = $derived(page.params.id ?? "");
  const detail = $derived(hostDetailQuery(id));
  const host = $derived($detail.data?.host);

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  let installer = $state<InstallCommand>();
  const STATUS = {
    online: { tone: "online", label: "Online" },
    offline: { tone: "offline", label: "Offline" },
    "auth-missing": { tone: "warning", label: "Auth missing" },
  } as const;
</script>

{#if $detail.isLoading}
  <PageShell title="Host" width="narrow"><StateBlock state="loading" rows={5} /></PageShell>
{:else if $detail.isError || !host || !$detail.data}
  <PageShell title="Host" width="narrow">
    <StateBlock state="error" message={`Could not load this host: ${$detail.error?.message ?? "not found"}`} onRetry={() => void $detail.refetch()} />
    <a href={`${base}/hosts`} class="text-body-sm underline">Back to all hosts</a>
  </PageShell>
{:else}
  {@const status = STATUS[hostStatusKind(host, now)]}
  <PageShell title={host.fqdn} description={`Host #${host.id}`} width="narrow">
    {#snippet actions()}
      <InstallCommand bind:this={installer} {id} fqdn={host.fqdn} curlInsecure={host.curl_insecure} />
    {/snippet}
    {#snippet subheader()}
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-muted-foreground">
        <StatusPill tone={status.tone} label={status.label} />
        <span title={hostLastSeen(host) ?? undefined}>Last contact {relativeTime(hostLastSeen(host)) || "never"}</span>
      </div>
    {/snippet}

    <HostAttention data={$detail.data} {id} onInstall={() => void installer?.mint()} />
    <div class="grid gap-x-10 gap-y-6 md:grid-cols-2">
      <EnginesSection {host} {id} />
      <AccessSection {host} {id} />
    </div>
    <AdvancedSection data={$detail.data} {id} />
    <DeleteHost {id} fqdn={host.fqdn} />
  </PageShell>
{/if}
