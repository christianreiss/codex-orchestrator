<script lang="ts">
  import { Section } from "$lib/components/page";
  import SessionHousekeeping from "$lib/components/policies/SessionHousekeeping.svelte";
  import ServerRetention from "$lib/components/policies/ServerRetention.svelte";
</script>

<!-- The destructive action (server retention: preview, then run) comes last. -->
<Section id="retention" title="Data retention" description="Manage local agent-session storage and server history. Active work stays protected.">
  <div class="divide-y border-y">
    <SessionHousekeeping />
    <ServerRetention />
  </div>
</Section>
