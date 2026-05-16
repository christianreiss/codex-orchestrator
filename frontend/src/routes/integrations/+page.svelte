<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { NotebookText } from "@lucide/svelte";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import IntegrationCard from "$lib/components/integrations/IntegrationCard.svelte";
  import { INTEGRATION_REGISTRY, integrationKeys, joplinApi } from "$lib/api/integrations";
  import { relativeTime } from "$lib/utils/format";
  import type { JoplinConfigState } from "$lib/api/types";

  // Per-integration status sources. As new integrations land they each
  // register their own query here.
  const joplin = createQuery<JoplinConfigState>({
    queryKey: integrationKeys.joplinConfig,
    queryFn: () => joplinApi.getConfig(),
    staleTime: 60_000,
  });

  function statusFor(slug: string): {
    status: "connected" | "disconnected" | "unconfigured" | "error";
    detail: string | null;
    loading: boolean;
  } {
    if (slug === "joplin") {
      const q = $joplin;
      if (q.isLoading) return { status: "disconnected", detail: null, loading: true };
      if (q.isError) return { status: "error", detail: "Could not load status", loading: false };
      const cfg = q.data;
      if (!cfg) return { status: "unconfigured", detail: null, loading: false };
      if (!cfg.config_complete) return { status: "unconfigured", detail: "Not yet configured", loading: false };
      if (!cfg.enabled) {
        return {
          status: "disconnected",
          detail: cfg.verified_connection ? "Configured · disabled" : "Configured · not verified",
          loading: false,
        };
      }
      const seen = cfg.verified_at ? `Verified ${relativeTime(cfg.verified_at)}` : "Verified connection";
      return { status: "connected", detail: seen, loading: false };
    }
    return { status: "unconfigured", detail: null, loading: false };
  }

  const iconFor = (slug: string) => (slug === "joplin" ? NotebookText : NotebookText);
</script>

<PageHeader
  title="Integrations"
  subtitle="Connect external systems so the orchestrator can read from or write to them"
/>

<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
  {#each INTEGRATION_REGISTRY as integration (integration.slug)}
    {@const s = statusFor(integration.slug)}
    <IntegrationCard
      name={integration.name}
      description={integration.description}
      href={integration.href}
      icon={iconFor(integration.slug)}
      status={s.status}
      detail={s.detail}
      loading={s.loading}
    />
  {/each}
</div>

{#if INTEGRATION_REGISTRY.length === 0}
  <div class="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
    No integrations available yet.
  </div>
{/if}
