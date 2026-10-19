<script lang="ts">
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  /**
   * People (admin users): one compact table, email under the name, a quick
   * active switch and a row menu. The destructive "wipe all" lives in
   * `WipeUsers`, last on the page.
   */
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import * as Table from "$lib/components/ui/table";
  import { Section, Toolbar, DataTable } from "$lib/components/page";
  import SortableHead from "$lib/components/data-table/SortableHead.svelte";
  import RowActions from "$lib/components/data-table/RowActions.svelte";
  import RoleBadge from "./RoleBadge.svelte";
  import UserFormDialog from "./UserFormDialog.svelte";
  import { cn } from "$lib/utils/cn";
  import {
    createUsersQuery,
    createUserCreateMutation,
    createUserUpdateMutation,
    createUserDeleteMutation,
  } from "$lib/api/users";
  import { USER_ROLES, type AdminUser, type AdminUserPayload } from "$lib/api/types";
  import { authStore } from "$lib/stores/auth";

  type SortKey = "person" | "role" | "status" | "last_login";

  // Every role may read the roster; only `users.manage` may change it. The
  // server refuses regardless: this keeps a viewer from filling in a form that
  // was never going to be accepted.
  const canManage = $derived($authStore.can("users.manage"));

  const usersQuery = createUsersQuery();
  const createMut = createUserCreateMutation();
  const updateMut = createUserUpdateMutation();
  const deleteMut = createUserDeleteMutation();

  let search = $state("");
  let sortKey = $state<SortKey>("person");
  let sortDir = $state<"asc" | "desc">("asc");
  let formOpen = $state(false);
  let formMode = $state<"create" | "edit">("create");
  let editTarget = $state<AdminUser | null>(null);
  let deleteOpen = $state(false);
  let deleteTarget = $state<AdminUser | null>(null);
  let pendingActiveIds = $state(new Set<number | string>());

  const users = $derived(($usersQuery.data ?? []) as AdminUser[]);
  const displayName = (u: AdminUser) => (u.name?.trim() || u.username || "").toLowerCase();

  function onSort(key: SortKey) {
    if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = key; sortDir = "asc"; }
  }

  // Sorts by the API's own privilege order (owner first), unknown roles last.
  function roleRank(role: string | undefined): number {
    const index = (USER_ROLES as readonly string[]).indexOf((role ?? "").toLowerCase());
    return index === -1 ? USER_ROLES.length : index;
  }

  const query = $derived(search.trim().toLowerCase());
  const rows = $derived.by(() => {
    const filtered = query
      ? users.filter((u) => {
          const role = String(u.access_level ?? "").toLowerCase();
          return [u.name, u.username, u.email, role, role.replace(/_/g, " ")].some((v) => (v ?? "").toLowerCase().includes(query));
        })
      : users;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "person": cmp = displayName(a).localeCompare(displayName(b)); break;
        case "role": cmp = roleRank(a.access_level) - roleRank(b.access_level); break;
        case "status": cmp = Number(b.active) - Number(a.active); break;
        case "last_login": cmp = (a.last_login_at ? new Date(a.last_login_at).getTime() : 0) - (b.last_login_at ? new Date(b.last_login_at).getTime() : 0); break;
      }
      if (cmp === 0) cmp = (a.username ?? "").localeCompare(b.username ?? "");
      return cmp * dir;
    });
  });

  function openAdd() { formMode = "create"; editTarget = null; formOpen = true; }
  function openEdit(user: AdminUser) { formMode = "edit"; editTarget = user; formOpen = true; }
  function openDelete(user: AdminUser) { deleteTarget = user; deleteOpen = true; }

  function clearUserParam(): void {
    if (!page.url.searchParams.has("user")) return;
    const url = new URL(page.url);
    url.searchParams.delete("user");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  // `?user=ID` deep link (used by notifications and the command palette).
  let handledUserParam = $state<string | null>(null);
  $effect(() => {
    const requestedId = page.url.searchParams.get("user");
    if (!requestedId) { handledUserParam = null; return; }
    if ($usersQuery.isLoading || handledUserParam === requestedId) return;
    handledUserParam = requestedId;
    const target = users.find((user) => String(user.id) === requestedId);
    if (target) { openEdit(target); return; }
    toast.error("User not found");
    clearUserParam();
  });

  async function handleFormSubmit(payload: AdminUserPayload) {
    try {
      if (formMode === "create") {
        await $createMut.mutateAsync(payload);
        toast.success("User created");
      } else if (editTarget) {
        const patch: Partial<AdminUserPayload> = { ...payload };
        if (!patch.password) delete patch.password;
        await $updateMut.mutateAsync({ id: editTarget.id, patch });
        toast.success("User updated");
      }
      formOpen = false;
      clearUserParam();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save user");
    }
  }

  async function handleToggleActive(user: AdminUser, next: boolean) {
    pendingActiveIds = new Set([...pendingActiveIds, user.id]);
    try {
      await $updateMut.mutateAsync({ id: user.id, patch: { active: next } });
      toast.success(next ? `Activated ${user.username}` : `Deactivated ${user.username}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Toggle failed");
    } finally {
      const copy = new Set(pendingActiveIds);
      copy.delete(user.id);
      pendingActiveIds = copy;
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      await $deleteMut.mutateAsync(target.id);
      toast.success(`Deleted ${target.username}`);
      deleteOpen = false;
      deleteTarget = null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }
</script>

<Section id="people" title="People" hideTitle>
  <div class="space-y-3">
    <Toolbar bind:search searchPlaceholder="Filter people" count={query ? `${rows.length} of ${users.length}` : `${users.length} ${users.length === 1 ? "person" : "people"}`}>
      {#snippet actions()}
        {#if canManage}<Button onclick={openAdd}><Plus class="h-4 w-4" />Add person</Button>{/if}
      {/snippet}
    </Toolbar>

    <DataTable
      items={rows}
      loading={$usersQuery.isLoading}
      error={$usersQuery.isError ? `Failed to load people: ${$usersQuery.error?.message ?? "Unknown error"}` : null}
      onRetry={() => void $usersQuery.refetch()}
      key={(u) => u.id}
      filtered={query !== ""}
      emptyTitle="No people"
      emptyDescription="This should be unreachable while you are signed in."
      caption="Admin users"
    >
      {#snippet head()}
        <SortableHead label="Person" active={sortKey === "person"} dir={sortDir} onclick={() => onSort("person")} class="min-w-48" />
        <SortableHead label="Role" active={sortKey === "role"} dir={sortDir} onclick={() => onSort("role")} class="hidden sm:table-cell" />
        <SortableHead label="Status" active={sortKey === "status"} dir={sortDir} onclick={() => onSort("status")} />
        <SortableHead label="Last login" active={sortKey === "last_login"} dir={sortDir} onclick={() => onSort("last_login")} class="hidden md:table-cell" />
        <Table.Head class="w-12"><span class="sr-only">Actions</span></Table.Head>
      {/snippet}
      {#snippet row(user)}
        <Table.Row>
          <Table.Cell>
            <div class="flex flex-wrap items-baseline gap-x-2">
              {#if user.name?.trim()}<span class="font-medium">{user.name.trim()}</span>{/if}
              <span class={cn("font-mono text-caption", user.name?.trim() ? "text-muted-foreground" : "text-body font-medium text-foreground")}>{user.username}</span>
            </div>
            {#if user.email}<div class="truncate text-caption text-muted-foreground">{user.email}</div>{/if}
            <div class="mt-1 sm:hidden"><RoleBadge role={user.access_level} /></div>
          </Table.Cell>
          <Table.Cell class="hidden sm:table-cell"><RoleBadge role={user.access_level} /></Table.Cell>
          <Table.Cell>
            <div class="flex items-center gap-2">
              <Switch
                checked={user.active}
                disabled={!canManage || pendingActiveIds.has(user.id)}
                onCheckedChange={(next) => handleToggleActive(user, Boolean(next))}
                aria-label={`${user.active ? "Deactivate" : "Activate"} ${user.username}`}
              />
              <span class={cn("hidden text-caption sm:inline", user.active ? "text-success" : "text-muted-foreground")}>{user.active ? "Active" : "Inactive"}</span>
            </div>
          </Table.Cell>
          <Table.Cell class="hidden text-body-sm md:table-cell">
            {#if user.last_login_at}
              <span title={new Date(user.last_login_at).toLocaleString()}><Timestamp value={user.last_login_at} /></span>
            {:else}
              <span class="text-muted-foreground">Never</span>
            {/if}
          </Table.Cell>
          <Table.Cell class="text-right">
            {#if canManage}
              <RowActions
                label={`Actions for ${user.username}`}
                actions={[
                  { label: "Edit", icon: Pencil, onClick: () => openEdit(user) },
                  { label: "Delete", icon: Trash2, destructive: true, onClick: () => openDelete(user) },
                ]}
              />
            {:else}
              <span class="text-caption text-muted-foreground">Read-only</span>
            {/if}
          </Table.Cell>
        </Table.Row>
      {/snippet}
    </DataTable>
  </div>
</Section>

<UserFormDialog
  open={formOpen}
  onOpenChange={(o) => { formOpen = o; if (!o) clearUserParam(); }}
  mode={formMode}
  initial={editTarget}
  submitting={$createMut.isPending || $updateMut.isPending}
  onSubmit={handleFormSubmit}
/>

<ConfirmDialog
  bind:open={deleteOpen}
  title="Delete person"
  description={`Permanently remove ${deleteTarget?.username ?? "this person"}? Their active sessions and password resets will also be revoked.`}
  confirmLabel="Delete person"
  destructive
  busy={$deleteMut.isPending}
  onConfirm={handleDeleteConfirm}
/>
