<script lang="ts">
  /** Who is signed in. Read-only: the API offers no self-service profile edit. */
  import { authStore } from "$lib/stores/auth";

  const user = $derived($authStore.user);
  const roles = $derived($authStore.roles);
  const rows = $derived(
    [
      { label: "Username", value: user?.username },
      { label: "Email", value: user?.email },
      { label: "Role", value: roles.length ? roles.join(", ") : null },
    ].filter((row) => row.value),
  );
</script>

{#if user?.name || rows.length}
  {#if user?.name}
    <p class="mb-5 break-words text-h2">{user.name}</p>
  {/if}
  <dl class="grid grid-cols-1 sm:grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-body">
    {#each rows as row (row.label)}
      <dt class="text-body-sm text-muted-foreground">{row.label}</dt>
      <dd class="mb-2 min-w-0 break-words sm:mb-0">{row.value}</dd>
    {/each}
  </dl>
{:else}
  <p class="text-body-sm text-muted-foreground">Signed-in user details are not available.</p>
{/if}
