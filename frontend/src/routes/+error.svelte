<script lang="ts">
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import { PageShell, StateBlock } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
</script>
<PageShell title={page.status === 404 ? "Page not found" : "Page unavailable"} width="narrow">
  <StateBlock state="error" message={page.error?.message ?? "This page could not be loaded."} onRetry={() => window.location.reload()} />
  <Button variant="outline" href={`${base}/dashboard`}>Return to Overview</Button>
</PageShell>
