<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import DangerZone from "$lib/components/layout/DangerZone.svelte";
  import { toast } from "svelte-sonner";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash from "@lucide/svelte/icons/trash";
  import Search from "@lucide/svelte/icons/search";
  import UsersIcon from "@lucide/svelte/icons/users";
  import UsersTable, { type SortKey, type SortDir } from "$lib/components/users/UsersTable.svelte";
  import UserFormDialog from "$lib/components/users/UserFormDialog.svelte";
  import WipeUsersDialog from "$lib/components/users/WipeUsersDialog.svelte";
  import ConfirmDeleteDialog from "$lib/components/users/ConfirmDeleteDialog.svelte";
  import {
    createUsersQuery,
    createUserCreateMutation,
    createUserUpdateMutation,
    createUserDeleteMutation,
    createWipeUsersMutation,
  } from "$lib/api/users";
  import { USER_ROLES, type AdminUser, type AdminUserPayload } from "$lib/api/types";
  import { authStore } from "$lib/stores/auth";

  // Every role may read the roster; only `users.manage` may change it. The
  // server refuses regardless — this keeps a viewer from filling in a form
  // that was never going to be accepted.
  const canManage = $derived($authStore.can("users.manage"));

  const usersQuery = createUsersQuery();
  const createMut = createUserCreateMutation();
  const updateMut = createUserUpdateMutation();
  const deleteMut = createUserDeleteMutation();
  const wipeMut = createWipeUsersMutation();

  let filter = $state("");
  let debouncedFilter = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const next = filter;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debouncedFilter = next.trim().toLowerCase();
    }, 180);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  let sortKey = $state<SortKey>("username");
  let sortDir = $state<SortDir>("asc");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
  }

  let formOpen = $state(false);
  let formMode = $state<"create" | "edit">("create");
  let editTarget = $state<AdminUser | null>(null);

  let wipeOpen = $state(false);
  let deleteOpen = $state(false);
  let deleteTarget = $state<AdminUser | null>(null);

  let pendingActiveIds = $state(new Set<number | string>());

  function openAdd() {
    formMode = "create";
    editTarget = null;
    formOpen = true;
  }

  function openEdit(user: AdminUser) {
    formMode = "edit";
    editTarget = user;
    formOpen = true;
  }

  function openDelete(user: AdminUser) {
    deleteTarget = user;
    deleteOpen = true;
  }

  const rawUsers = $derived(($usersQuery.data ?? []) as AdminUser[]);

  function clearUserParam(): void {
    if (!page.url.searchParams.has("user")) return;
    const url = new URL(page.url);
    url.searchParams.delete("user");
    void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
  }

  let handledUserParam = $state<string | null>(null);
  $effect(() => {
    const requestedId = page.url.searchParams.get("user");
    const loading = $usersQuery.isLoading;
    const users = rawUsers;
    if (!requestedId) {
      handledUserParam = null;
      return;
    }
    if (loading || handledUserParam === requestedId) return;
    handledUserParam = requestedId;
    const target = users.find((user) => String(user.id) === requestedId);
    if (target) {
      openEdit(target);
      return;
    }
    toast.error("User not found");
    clearUserParam();
  });

  // Sorts by the API's own privilege order (owner first), unknown roles last.
  function roleRank(role: string | undefined): number {
    const index = (USER_ROLES as readonly string[]).indexOf((role ?? "").toLowerCase());
    return index === -1 ? USER_ROLES.length : index;
  }

  const filteredSorted = $derived.by(() => {
    const q = debouncedFilter;
    const filtered = q
      ? rawUsers.filter((u) => {
          const role = String(u.access_level ?? "").toLowerCase();
          return (
            (u.name ?? "").toLowerCase().includes(q) ||
            (u.username ?? "").toLowerCase().includes(q) ||
            (u.email ?? "").toLowerCase().includes(q) ||
            role.includes(q) ||
            role.replace(/_/g, " ").includes(q)
          );
        })
      : rawUsers;

    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = (a.name ?? "").localeCompare(b.name ?? "");
          break;
        case "username":
          cmp = (a.username ?? "").localeCompare(b.username ?? "");
          break;
        case "role":
          cmp = roleRank(a.access_level) - roleRank(b.access_level);
          break;
        case "status":
          cmp = Number(b.active) - Number(a.active);
          break;
        case "last_login": {
          const ta = a.last_login_at ? new Date(a.last_login_at).getTime() : 0;
          const tb = b.last_login_at ? new Date(b.last_login_at).getTime() : 0;
          cmp = ta - tb;
          break;
        }
      }
      if (cmp === 0) cmp = (a.username ?? "").localeCompare(b.username ?? "");
      return cmp * dir;
    });
    return sorted;
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

  async function handleWipeConfirm() {
    try {
      await $wipeMut.mutateAsync();
      toast.success("All users wiped");
      wipeOpen = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Wipe failed");
    }
  }

  const totalCount = $derived(rawUsers.length);
  const visibleCount = $derived(filteredSorted.length);
</script>

<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div class="relative w-full sm:max-w-sm">
    <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    <Input
      bind:value={filter}
      placeholder="Filter by name, username, email, role..."
      class="pl-9"
      aria-label="Filter users"
    />
  </div>
  <div class="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
    <p class="mr-1 text-xs text-muted-foreground">
      {#if debouncedFilter}
        Showing {visibleCount} of {totalCount}
      {:else}
        <span class="inline-flex items-center gap-1">
          <UsersIcon class="h-3 w-3" />
          {totalCount} {totalCount === 1 ? "user" : "users"}
        </span>
      {/if}
    </p>
    {#if canManage}
      <Button onclick={openAdd}>
        <Plus class="h-4 w-4" />
        Add user
      </Button>
    {/if}
  </div>
</div>

{#if $usersQuery.isError}
  <div
    role="alert"
    class="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
  >
    Failed to load users: {$usersQuery.error?.message ?? "Unknown error"}
  </div>
{/if}

<UsersTable
  users={filteredSorted}
  loading={$usersQuery.isLoading}
  isEmpty={totalCount === 0}
  filterQuery={debouncedFilter}
  {sortKey}
  {sortDir}
  {pendingActiveIds}
  {canManage}
  onSort={handleSort}
  onToggleActive={handleToggleActive}
  onEdit={openEdit}
  onDelete={openDelete}
  onClearFilter={() => (filter = "")}
/>

{#if canManage}
  <DangerZone description="Permanently delete every admin user account. This cannot be undone.">
    <Button
      variant="destructive"
      onclick={() => (wipeOpen = true)}
      disabled={totalCount === 0}
    >
      <Trash class="h-4 w-4" />
      Wipe all users
    </Button>
  </DangerZone>
{/if}

<UserFormDialog
  open={formOpen}
  onOpenChange={(o) => {
    formOpen = o;
    if (!o) clearUserParam();
  }}
  mode={formMode}
  initial={editTarget}
  submitting={$createMut.isPending || $updateMut.isPending}
  onSubmit={handleFormSubmit}
/>

<WipeUsersDialog
  open={wipeOpen}
  onOpenChange={(o) => (wipeOpen = o)}
  submitting={$wipeMut.isPending}
  onConfirm={handleWipeConfirm}
/>

<ConfirmDeleteDialog
  open={deleteOpen}
  onOpenChange={(o) => (deleteOpen = o)}
  submitting={$deleteMut.isPending}
  username={deleteTarget?.username}
  onConfirm={handleDeleteConfirm}
/>
