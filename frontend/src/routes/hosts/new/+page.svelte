<script lang="ts">
  /**
   * /hosts/new is a thin shell: the New Host sheet lives in /hosts/+page.svelte
   * and reads the pathname to auto-open. We render the same list underneath so
   * the sheet has visual context.
   */
  import HostsList from "../+page.svelte";
</script>

<HostsList />
