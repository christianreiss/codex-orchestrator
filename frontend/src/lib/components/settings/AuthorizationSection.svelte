<script lang="ts">
  /**
   * The fleet's authorization posture, and the evidence for changing it.
   *
   * Existing installations upgrade into `compatible`, which reproduces the
   * rules they had before the capability matrix existed — nobody loses access
   * on upgrade. Switching to `strict` is the operator's decision, and this is
   * where they make it with data rather than by auditing a roster: while the
   * fleet runs `compatible`, every request the matrix *would* have refused is
   * recorded, and the list below is what would start returning 403.
   *
   * An empty list on a fleet that has been running a while is the signal that
   * switching costs nothing.
   */
  import { authorizationMutation, authorizationQuery } from "$lib/api/settings";
  import { authStore } from "$lib/stores/auth";

  const query = authorizationQuery();
  const mutation = authorizationMutation();

  const canManage = $derived($authStore.can("security.manage_authorization"));
  const mode = $derived($query.data?.mode ?? null);
  const wouldDeny = $derived($query.data?.would_deny ?? []);

  function shortDate(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }
</script>

<section class="authorization" aria-labelledby="authorization-heading">
  <h3 id="authorization-heading">Authorization</h3>

  {#if $query.isPending}
    <p class="muted">Loading…</p>
  {:else if $query.isError}
    <p class="muted">Could not read the authorization posture.</p>
  {:else if mode === "compatible"}
    <p>
      This fleet runs in <strong>compatible</strong> mode: the rules it had before
      roles carried capabilities. Owners and admins may do everything; every other
      role is refused the same routes it was refused before, and nothing else.
      Upgrading did not change what anyone could do.
    </p>

    {#if wouldDeny.length === 0}
      <p class="good">
        Nothing recorded. No request served here would have been refused under
        <strong>strict</strong>, so switching should cost nothing.
      </p>
    {:else}
      <p>
        Switching to <strong>strict</strong> would start refusing the following
        {wouldDeny.length}
        {wouldDeny.length === 1 ? "request" : "distinct requests"} seen on this
        fleet. Promote the accounts that need to keep working first.
      </p>
      <table>
        <thead>
          <tr><th>Role</th><th>Needs</th><th>Route</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          {#each wouldDeny as record (record.role + record.capability + record.route)}
            <tr>
              <td>{record.role}</td>
              <td><code>{record.capability}</code></td>
              <td><code>{record.route}</code></td>
              <td>{shortDate(record.last_seen)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <button
      type="button"
      disabled={!canManage || $mutation.isPending}
      title={canManage
        ? undefined
        : "Requires the security.manage_authorization capability."}
      onclick={() => $mutation.mutateAsync("strict")}
    >
      {$mutation.isPending ? "Switching…" : "Switch to strict"}
    </button>
  {:else}
    <p>
      This fleet runs in <strong>strict</strong> mode: every route requires the
      capability its role holds, and anything else is refused.
    </p>
    <button
      type="button"
      disabled={!canManage || $mutation.isPending}
      title={canManage
        ? undefined
        : "Requires the security.manage_authorization capability."}
      onclick={() => $mutation.mutateAsync("compatible")}
    >
      {$mutation.isPending ? "Switching…" : "Revert to compatible"}
    </button>
  {/if}

  {#if $mutation.isError}
    <p class="error">{$mutation.error?.message ?? "Could not change the mode."}</p>
  {/if}
</section>

<style>
  .authorization {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9em;
  }
  th,
  td {
    text-align: left;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--border, #ddd);
  }
  .muted {
    opacity: 0.7;
  }
  .error {
    color: var(--danger, #b00);
  }
  button {
    align-self: flex-start;
  }
</style>
