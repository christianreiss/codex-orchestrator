<script lang="ts">
  import { PageShell, Section } from "$lib/components/page";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
  import ScalingSection from "$lib/components/settings/ScalingSection.svelte";
</script>

<PageShell title="Usage limits" description="What happens when an account nears its quota, how clients are advised to switch provider, and how fleet usage changes lane, effort or model.">
  <Section id="quota-enforcement" title="Quotas" hideTitle>
    <QuotasSection />
  </Section>

  <Section id="scaling-rules" title="Usage-based scaling" description="Tiers that change lane, effort or model as fleet usage rises. Hosts marked Always allowed (they ignore usage limits) are exempt.">
    <ScalingSection />
  </Section>
</PageShell>
