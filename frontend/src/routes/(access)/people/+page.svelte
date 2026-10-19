<script lang="ts">
  import { PageShell } from "$lib/components/page";
  import PeopleSection from "$lib/components/users/PeopleSection.svelte";
  import WipeUsers from "$lib/components/users/WipeUsers.svelte";
</script>

<PageShell title="People" description="Who can sign in to this console: admin accounts, their role and whether they are active.">
  <div class="space-y-8">
    <PeopleSection />
    <WipeUsers />
  </div>
</PageShell>
