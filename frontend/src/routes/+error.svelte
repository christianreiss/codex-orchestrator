<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  const missing = $derived(page.status === 404);
  let retrying = false;

  async function retryPage() {
    if (retrying) return;
    retrying = true;
    // WebKit can retain a failed module import across a document reload.
    // A regular fetch makes restored assets available to the module loader again.
    const prefix = new URL(`${base}/_app/immutable/`, location.origin).href;
    const assets = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const failed = assets.filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".js")
      && (entry.responseStatus >= 400 || entry.decodedBodySize === 0));
    const urls = new Set(failed.map((entry) => entry.name));
    const signal = AbortSignal.timeout(3000);
    await Promise.allSettled([...urls].map((url) => fetch(url, { signal })));
    window.location.reload();
  }
</script>

<PageShell title={missing ? "Page not found" : "Page unavailable"}
           description={missing ? "Check the address or open Overview to find your page." : undefined} width="narrow">
  {#if !missing}
    <StateBlock state="error" message={page.error?.message ?? "This page could not be loaded."} onRetry={retryPage} />
  {/if}
  <Button variant="outline" href={`${base}/dashboard`}>Return to Overview</Button>
</PageShell>
