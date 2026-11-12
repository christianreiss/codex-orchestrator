<script lang="ts">
  import { PageShell } from "$lib/components/page";
  import ApiKeysSection from "$lib/components/api-keys/ApiKeysSection.svelte";
</script>

<PageShell title="API keys" description="Keys for applications that call the fleet's OpenAI-, Anthropic-, Grok- and Kimi-compatible endpoints.">
  <ApiKeysSection />
</PageShell>
