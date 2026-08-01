<script lang="ts">
  import AccountSideNav from "$lib/components/account/AccountSideNav.svelte";
  let { children } = $props();
</script>

<div class="space-y-5">
  <AccountSideNav />
  <div class="min-w-0">
    {@render children?.()}
  </div>
</div>
