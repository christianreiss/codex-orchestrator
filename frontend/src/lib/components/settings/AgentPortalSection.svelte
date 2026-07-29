<script lang="ts">
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import SectionCard from "./SectionCard.svelte";
  import SwitchRow from "./SwitchRow.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { authStore } from "$lib/stores/auth";

  type PortalState = {
    enabled: boolean;
    configured: boolean;
    enabled_users: number;
    active_sessions: number;
    queued_messages: number;
    dead_messages: number;
    queued_matrix: number;
    dead_matrix: number;
    matrix_configured: boolean;
  };
  type PortalUser = {
    id: number;
    display_name: string;
    matrix_room: string;
    enabled: boolean;
    last_used_at: string | null;
  };

  let portalState = $state<PortalState | null>(null);
  let users = $state<PortalUser[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let displayName = $state("");
  let matrixRoom = $state("");
  let latestLink = $state("");
  let error = $state("");
  const accessLevel = $derived(
    ($authStore.user as (typeof $authStore.user & { access_level?: string }) | null)?.access_level,
  );
  const canMutate = $derived(
    [...$authStore.roles, accessLevel ?? ""]
      .map((role) => role.trim().toLowerCase())
      .some((role) => role === "owner" || role === "admin"),
  );

  onMount(() => void load());

  async function load() {
    loading = true;
    error = "";
    try {
      const [stateResult, usersResult] = await Promise.all([
        api.get<PortalState>("/admin/agent-portal/state"),
        api.get<{ users: PortalUser[] }>("/admin/agent-portal/users"),
      ]);
      portalState = stateResult;
      users = usersResult.users;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      loading = false;
    }
  }

  async function setMaster(enabled: boolean) {
    saving = true;
    try {
      await api.post("/admin/agent-portal/state", { enabled });
      toast.success(enabled ? "Agent portal enabled" : "Agent portal disabled; pending input cancelled");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving = false;
    }
  }

  async function createUser() {
    if (!displayName.trim() || !matrixRoom.trim()) return;
    saving = true;
    try {
      const result = await api.post<{ magic_url: string }>("/admin/agent-portal/users", {
        display_name: displayName,
        matrix_room: matrixRoom,
      });
      latestLink = result.magic_url;
      displayName = "";
      matrixRoom = "";
      toast.success("Portal user created and enabled");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving = false;
    }
  }

  async function setUserEnabled(user: PortalUser) {
    saving = true;
    try {
      await api.post(`/admin/agent-portal/users/${user.id}/enabled`, { enabled: !user.enabled });
      toast.success(user.enabled ? "User disabled" : "User enabled");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving = false;
    }
  }

  async function resend(user: PortalUser) {
    saving = true;
    try {
      await api.post(`/admin/agent-portal/users/${user.id}/resend`);
      toast.success("Permanent link queued for Matrix");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving = false;
    }
  }

  async function rotate(user: PortalUser) {
    if (!confirm(`Rotate ${user.display_name}'s permanent link? Existing browser sessions will be logged out.`)) return;
    saving = true;
    try {
      const result = await api.post<{ magic_url: string }>(`/admin/agent-portal/users/${user.id}/rotate`);
      latestLink = result.magic_url;
      toast.success("Permanent link rotated");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving = false;
    }
  }

  async function remove(user: PortalUser) {
    if (!confirm(`Delete portal access for ${user.display_name}?`)) return;
    saving = true;
    try {
      await api.delete(`/admin/agent-portal/users/${user.id}`);
      toast.success("Portal user deleted");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving = false;
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(latestLink);
    toast.success("Magic link copied");
  }
</script>

<SectionCard
  id="agent-portal"
  title="Agent portal"
  description="Permanent Matrix-delivered login links for the fleet-wide Codex and Claude chat portal. Turning it off cancels pending remote instructions without stopping local agents."
  status={saving ? "saving" : error ? "error" : "idle"}
  {error}
>
  <SwitchRow
    id="agent-portal-toggle"
    label="Enable remote agent portal"
    description={loading
      ? "Loading…"
      : !portalState?.configured
        ? "PUBLIC_BASE_URL and Matrix API credentials must be configured first."
        : portalState?.enabled
          ? `${portalState.active_sessions} active agents · ${portalState.queued_messages} queued instructions · ${portalState.queued_matrix} Matrix notices`
          : "Portal login, bridge delivery, and Matrix notices are disabled."}
    checked={portalState?.enabled ?? false}
    disabled={!canMutate || loading || saving || (!portalState?.configured && !portalState?.enabled)}
    onCheckedChange={setMaster}
  />

  {#if portalState && (portalState.dead_messages || portalState.dead_matrix)}
    <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      Dead letters: {portalState.dead_messages} agent instructions, {portalState.dead_matrix} Matrix notices.
    </div>
  {/if}

  {#if canMutate}
    <div class="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]">
      <Input bind:value={displayName} placeholder="Display name" aria-label="Portal user display name" />
      <Input bind:value={matrixRoom} placeholder="Matrix DM room or alias" aria-label="Matrix destination" />
      <Button onclick={createUser} disabled={saving || !displayName.trim() || !matrixRoom.trim()}>Add user</Button>
    </div>
  {:else}
    <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Read-only. Owner or admin access is required to change portal settings or users.</div>
  {/if}

  {#if latestLink}
    <div class="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
      <p class="text-xs font-medium">New permanent link — shown here only for this create/rotation response</p>
      <code class="block break-all text-xs text-muted-foreground">{latestLink}</code>
      <Button size="sm" variant="outline" onclick={copyLink}>Copy link</Button>
    </div>
  {/if}

  <div class="space-y-2">
    {#each users as portalUser (portalUser.id)}
      <div class="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <strong class="truncate text-sm">{portalUser.display_name}</strong>
            <span class:opacity-50={!portalUser.enabled} class="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase">{portalUser.enabled ? "enabled" : "disabled"}</span>
          </div>
          <p class="truncate text-xs text-muted-foreground">{portalUser.matrix_room}</p>
        </div>
        {#if canMutate}
          <div class="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onclick={() => setUserEnabled(portalUser)}>{portalUser.enabled ? "Disable" : "Enable"}</Button>
            <Button size="sm" variant="outline" onclick={() => resend(portalUser)} disabled={!portalUser.enabled || !portalState?.enabled}>Resend</Button>
            <Button size="sm" variant="outline" onclick={() => rotate(portalUser)}>Rotate</Button>
            <Button size="sm" variant="destructive" onclick={() => remove(portalUser)}>Delete</Button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="text-xs text-muted-foreground">No portal users configured.</p>
    {/each}
  </div>
</SectionCard>
