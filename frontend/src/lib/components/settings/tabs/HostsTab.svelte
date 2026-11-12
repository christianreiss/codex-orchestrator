<script lang="ts">
  import { Section } from "$lib/components/page";
  import TogglePolicy from "$lib/components/policies/TogglePolicy.svelte";
  import CleanupPolicy from "$lib/components/policies/CleanupPolicy.svelte";
</script>

<Section id="hosts" title="Hosts" description="How managed hosts update, identify themselves and get access. A badge shows when individual hosts override a setting.">
  <div class="divide-y border-y">
    <TogglePolicy id="auto-update" />
    <TogglePolicy id="reverse-dns" />
    <TogglePolicy id="insecure-approval" />
    <TogglePolicy id="host-spawn" />
    <div id="host-lifecycle" class="scroll-mt-24"><CleanupPolicy /></div>
  </div>
</Section>
