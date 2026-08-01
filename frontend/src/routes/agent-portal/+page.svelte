<script lang="ts">
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import AgentPortalPage from "../settings/agent-portal/+page.svelte";
</script>

<PageHeader title="Agent Portal" subtitle="Portal switch and permanent-link lifecycle. The portal is pull-only; no notification is sent elsewhere." />
<AgentPortalPage />
