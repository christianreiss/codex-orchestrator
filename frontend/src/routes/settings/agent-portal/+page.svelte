<script lang="ts">
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import SwitchRow from "$lib/components/settings/SwitchRow.svelte";
  import ConfirmDialog from "$lib/components/hosts/ConfirmDialog.svelte";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import { authStore } from "$lib/stores/auth";
  import Users from "@lucide/svelte/icons/users";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  type PortalState = {
    enabled: boolean;
    configured: boolean;
    enabled_users: number;
    active_sessions: number;
    queued_messages: number;
    dead_messages: number;
  };
  type PortalUser = {
    id: number;
    display_name: string;
    enabled: boolean;
    last_used_at: string | null;
  };

  const queryClient = useQueryClient();
  const stateQuery = createQuery({
    queryKey: ["agent-portal", "state"],
    queryFn: () => api.get<PortalState>("/admin/agent-portal/state"),
  });
  const usersQuery = createQuery({
    queryKey: ["agent-portal", "users"],
    queryFn: () => api.get<{ users: PortalUser[] }>("/admin/agent-portal/users"),
  });
  const portalState = $derived($stateQuery.data ?? null);
  const users = $derived($usersQuery.data?.users ?? []);
  const loading = $derived($stateQuery.isLoading || $usersQuery.isLoading);
  let saving = $state(false);
  let displayName = $state("");
  /** Revealed permanent links, by portal user id. Never fetched in bulk. */
  let links = $state<Record<number, string>>({});
  const accessLevel = $derived(
    ($authStore.user as (typeof $authStore.user & { access_level?: string }) | null)?.access_level,
  );
  const canMutate = $derived(
    [...$authStore.roles, accessLevel ?? ""]
      .map((role) => role.trim().toLowerCase())
      .some((role) => role === "owner" || role === "admin"),
  );

  // Which user a confirm dialog is currently targeting.
  let actionTarget = $state<PortalUser | null>(null);
  let confirmRotateOpen = $state(false);
  let confirmRemoveOpen = $state(false);

  async function load() {
    await queryClient.invalidateQueries({ queryKey: ["agent-portal"] });
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
    if (!displayName.trim()) return;
    saving = true;
    try {
      const result = await api.post<{ user: PortalUser; magic_url: string }>("/admin/agent-portal/users", {
        display_name: displayName,
      });
      links = { ...links, [result.user.id]: result.magic_url };
      displayName = "";
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

  async function showLink(user: PortalUser) {
    saving = true;
    try {
      const result = await api.get<{ magic_url: string }>(`/admin/agent-portal/users/${user.id}/link`);
      links = { ...links, [user.id]: result.magic_url };
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving = false;
    }
  }

  function hideLink(user: PortalUser) {
    const { [user.id]: _removed, ...rest } = links;
    links = rest;
  }

  function openRotate(user: PortalUser): void {
    actionTarget = user;
    confirmRotateOpen = true;
  }

  function openRemove(user: PortalUser): void {
    actionTarget = user;
    confirmRemoveOpen = true;
  }

  async function doRotate(): Promise<void> {
    const user = actionTarget;
    if (!user) return;
    saving = true;
    try {
      const result = await api.post<{ magic_url: string }>(`/admin/agent-portal/users/${user.id}/rotate`);
      links = { ...links, [user.id]: result.magic_url };
      toast.success("Permanent link rotated — re-bookmark the new link");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      saving = false;
    }
  }

  async function doRemove(): Promise<void> {
    const user = actionTarget;
    if (!user) return;
    saving = true;
    try {
      await api.delete(`/admin/agent-portal/users/${user.id}`);
      hideLink(user);
      toast.success("Portal user deleted");
      await load();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      saving = false;
    }
  }

  async function copyLink(url: string) {
    await navigator.clipboard.writeText(url);
    toast.success("Permanent link copied");
  }
</script>

<div class="grid grid-cols-1 gap-4">
  <Card.Root>
    <Card.Content class="space-y-3 pt-4">
      <SwitchRow
        id="agent-portal-toggle"
        label="Enable remote agent portal"
        description={loading
          ? "Loading…"
          : !portalState?.configured
            ? "PUBLIC_BASE_URL must be configured first."
            : portalState?.enabled
              ? `${portalState.active_sessions} active agents · ${portalState.queued_messages} queued instructions`
              : "Portal login and bridge delivery are disabled. Turning it off cancels pending remote instructions without stopping local agents."}
        checked={portalState?.enabled ?? false}
        disabled={!canMutate || loading || saving || (!portalState?.configured && !portalState?.enabled)}
        onCheckedChange={setMaster}
      />
      {#if portalState && portalState.dead_messages}
        <div class="rounded-md border border-destructive/25 bg-destructive-muted px-3 py-2 text-xs text-destructive-muted-foreground">
          Dead letters: {portalState.dead_messages} agent instructions.
        </div>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Portal users</Card.Title>
      <Card.Description>Each user gets one permanent bookmarkable login link.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-3">
      {#if canMutate}
        <div class="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_auto]">
          <Input bind:value={displayName} placeholder="Display name" aria-label="Portal user display name" />
          <Button onclick={createUser} disabled={saving || !displayName.trim()}>Add user</Button>
        </div>
      {:else}
        <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Read-only. Owner or admin access is required to change portal settings or users.
        </div>
      {/if}

      <div class="space-y-2">
        {#each users as portalUser (portalUser.id)}
          <div class="space-y-2 rounded-md border px-3 py-2">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <strong class="truncate text-sm">{portalUser.display_name}</strong>
                  <span class:opacity-50={!portalUser.enabled} class="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase">{portalUser.enabled ? "enabled" : "disabled"}</span>
                </div>
                <p class="truncate text-xs text-muted-foreground">
                  {portalUser.last_used_at ? `Last portal login ${portalUser.last_used_at}` : "Never signed in"}
                </p>
              </div>
              {#if canMutate}
                <div class="flex flex-wrap items-center gap-1.5">
                  {#if links[portalUser.id]}
                    <Button size="sm" variant="outline" onclick={() => hideLink(portalUser)}>Hide link</Button>
                  {:else}
                    <Button size="sm" variant="outline" onclick={() => showLink(portalUser)}>Show link</Button>
                  {/if}
                  <Button size="sm" variant="outline" onclick={() => setUserEnabled(portalUser)}>{portalUser.enabled ? "Disable" : "Enable"}</Button>
                  <RowActions
                    label={`Actions for ${portalUser.display_name}`}
                    actions={[
                      { label: "Rotate link", icon: RefreshCw, onClick: () => openRotate(portalUser) },
                      { label: "Delete", icon: Trash2, destructive: true, onClick: () => openRemove(portalUser) },
                    ]}
                  />
                </div>
              {/if}
            </div>

            {#if links[portalUser.id]}
              <div class="space-y-2 rounded-md border border-success/25 bg-success-muted p-3">
                <!-- Not "add to home screen": the portal ships no manifest or
                     service worker, so it has no standalone or offline mode. -->
                <p class="text-xs font-medium">Permanent portal link — bookmark it on every device that needs it</p>
                <!-- rel=noreferrer keeps the token fragment out of any downstream Referer. -->
                <a
                  class="block break-all text-xs underline underline-offset-2"
                  href={links[portalUser.id]}
                  target="_blank"
                  rel="noreferrer">{links[portalUser.id]}</a
                >
                <div class="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onclick={() => copyLink(links[portalUser.id]!)}>Copy link</Button>
                </div>
                <p class="text-[11px] text-muted-foreground">
                  Anyone holding this URL can read and instruct this fleet's agents. Rotate it if it leaks.
                </p>
              </div>
            {/if}
          </div>
        {:else}
          <EmptyState
            icon={Users}
            size="sm"
            title="No portal users yet"
            description="Add one above to hand out a bookmarkable login link to the agent chat portal."
          />
        {/each}
      </div>
    </Card.Content>
  </Card.Root>
</div>

<ConfirmDialog
  bind:open={confirmRotateOpen}
  onOpenChange={(v) => (confirmRotateOpen = v)}
  title="Rotate permanent link?"
  description={actionTarget
    ? `Existing bookmarks and browser sessions for ${actionTarget.display_name} stop working immediately.`
    : ""}
  confirmLabel="Rotate"
  destructive
  onConfirm={doRotate}
/>
<ConfirmDialog
  bind:open={confirmRemoveOpen}
  onOpenChange={(v) => (confirmRemoveOpen = v)}
  title="Delete portal access?"
  description={actionTarget
    ? `Permanently remove portal access for ${actionTarget.display_name}. This cannot be undone.`
    : ""}
  confirmLabel="Delete"
  destructive
  onConfirm={doRemove}
/>
