<script lang="ts">
  import AccountSideNav from "$lib/components/account/AccountSideNav.svelte";
  let { children } = $props();
</script>

<div class="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)] md:gap-10">
  <AccountSideNav />
  <div class="min-w-0">
    {@render children?.()}
  </div>
</div>
