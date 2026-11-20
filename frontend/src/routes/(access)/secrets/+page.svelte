<script lang="ts">
  import { PageShell } from "$lib/components/page";
  import SecretsSection from "$lib/components/secrets/SecretsSection.svelte";
</script>

<PageShell title="Secrets" description="Working credentials that agents can read over MCP.">
  <SecretsSection />
</PageShell>
