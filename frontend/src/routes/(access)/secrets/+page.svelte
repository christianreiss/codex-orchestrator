<script lang="ts">
  import { PageShell } from "$lib/components/page";
  import SecretsSection from "$lib/components/secrets/SecretsSection.svelte";
</script>

<PageShell title="Secrets" description="Working credentials that Codex, Claude and Grok agents can read over MCP.">
  <SecretsSection />
</PageShell>
