<script lang="ts">
  import { PageShell, Section } from "$lib/components/page";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
</script>

<PageShell title="Usage limits" description="What happens when an account nears its quota and how clients are advised to switch provider.">
  <Section id="quota-enforcement" title="Quotas" hideTitle>
    <QuotasSection />
  </Section>
</PageShell>
