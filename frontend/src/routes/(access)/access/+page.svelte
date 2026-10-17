<script lang="ts">
  import { PageShell } from "$lib/components/page";
  import PeopleSection from "$lib/components/users/PeopleSection.svelte";
  import WipeUsers from "$lib/components/users/WipeUsers.svelte";
  import ApiKeysSection from "$lib/components/api-keys/ApiKeysSection.svelte";
  import SecretsSection from "$lib/components/secrets/SecretsSection.svelte";

  const anchors = [
    { id: "people", label: "People" },
    { id: "api-keys", label: "API keys" },
    { id: "secrets", label: "Secrets" },
  ];
</script>

<PageShell title="Access" description="Who can sign in, which applications can call the fleet API, and the credentials agents may read.">
  {#snippet subheader()}
    <nav aria-label="On this page" class="sticky top-0 z-10 -mt-1 flex gap-1 border-b bg-background py-1">
      {#each anchors as anchor (anchor.id)}
        <a href={`#${anchor.id}`} class="rounded-md px-2.5 py-1.5 text-body-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{anchor.label}</a>
      {/each}
    </nav>
  {/snippet}

  <div class="space-y-8">
    <PeopleSection />
    <ApiKeysSection />
    <SecretsSection />
    <WipeUsers />
  </div>
</PageShell>
