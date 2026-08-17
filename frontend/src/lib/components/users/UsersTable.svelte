<script lang="ts">
  import * as Table from "$lib/components/ui/table";
  import { Switch } from "$lib/components/ui/switch";
  import { Button } from "$lib/components/ui/button";
  import { EmptyState } from "$lib/components/ui/empty-state";
  import { cn } from "$lib/utils/cn";
  import { relativeTime } from "$lib/utils/format";
  import RoleBadge from "./RoleBadge.svelte";
  import type { AdminUser } from "$lib/api/types";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Search from "@lucide/svelte/icons/search";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

  export type SortKey = "name" | "username" | "role" | "status" | "last_login";
  export type SortDir = "asc" | "desc";

  type Props = {
    users: AdminUser[];
    loading?: boolean;
    /** True once there are zero users with no filter applied — should be unreachable while signed in. */
    isEmpty?: boolean;
    /** The active search string, if any — distinguishes "no data" from "no matches". */
    filterQuery?: string;
    sortKey: SortKey;
    sortDir: SortDir;
    pendingActiveIds?: Set<number | string>;
    /**
     * Whether the signed-in operator holds `users.manage`. The roster itself
     * is readable by every role — the row controls are not.
     */
    canManage?: boolean;
    onSort: (key: SortKey) => void;
    onToggleActive: (user: AdminUser, next: boolean) => void;
    onEdit: (user: AdminUser) => void;
    onDelete: (user: AdminUser) => void;
    onClearFilter?: () => void;
  };

  let {
    users,
    loading = false,
    isEmpty = false,
    filterQuery = "",
    sortKey,
    sortDir,
    pendingActiveIds = new Set(),
    canManage = false,
    onSort,
    onToggleActive,
    onEdit,
    onDelete,
    onClearFilter,
  }: Props = $props();

  function absoluteTime(value: string | null | undefined): string {
    if (!value) return "Never";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString();
  }
</script>

<div class="overflow-hidden rounded-md border border-border/75 bg-card">
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head class="min-w-[160px]" aria-sort={sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
          <button
            type="button"
            class="-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
            onclick={() => onSort("name")}
          >
            Name
            {#if sortKey === "name"}
              {#if sortDir === "asc"}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
            {:else}
              <ChevronsUpDown class="h-3 w-3 opacity-50" />
            {/if}
          </button>
        </Table.Head>
        <Table.Head class="min-w-[140px]" aria-sort={sortKey === "username" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
          <button
            type="button"
            class="-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
            onclick={() => onSort("username")}
          >
            Username
            {#if sortKey === "username"}
              {#if sortDir === "asc"}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
            {:else}
              <ChevronsUpDown class="h-3 w-3 opacity-50" />
            {/if}
          </button>
        </Table.Head>
        <Table.Head class="hidden lg:table-cell">Email</Table.Head>
        <Table.Head class="min-w-[140px]" aria-sort={sortKey === "role" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
          <button
            type="button"
            class="-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
            onclick={() => onSort("role")}
          >
            Role
            {#if sortKey === "role"}
              {#if sortDir === "asc"}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
            {:else}
              <ChevronsUpDown class="h-3 w-3 opacity-50" />
            {/if}
          </button>
        </Table.Head>
        <Table.Head class="w-[110px]" aria-sort={sortKey === "status" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
          <button
            type="button"
            class="-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
            onclick={() => onSort("status")}
          >
            Active
            {#if sortKey === "status"}
              {#if sortDir === "asc"}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
            {:else}
              <ChevronsUpDown class="h-3 w-3 opacity-50" />
            {/if}
          </button>
        </Table.Head>
        <Table.Head class="hidden xl:table-cell" aria-sort={sortKey === "last_login" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
          <button
            type="button"
            class="-mx-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
            onclick={() => onSort("last_login")}
          >
            Last login
            {#if sortKey === "last_login"}
              {#if sortDir === "asc"}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
            {:else}
              <ChevronsUpDown class="h-3 w-3 opacity-50" />
            {/if}
          </button>
        </Table.Head>
        <Table.Head class="w-[120px] text-right">Actions</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#if loading && users.length === 0}
        {#each [0, 1, 2, 3] as i (i)}
          <Table.Row>
            <Table.Cell colspan={7}>
              <div class="h-8 w-full animate-pulse rounded bg-muted/60"></div>
            </Table.Cell>
          </Table.Row>
        {/each}
      {:else if users.length === 0 && isEmpty}
        <Table.Row>
          <Table.Cell colspan={7}>
            <EmptyState
              icon={TriangleAlert}
              title="No users"
              description="This should be unreachable while you're signed in — if you're seeing this, something is wrong with the users list."
            />
          </Table.Cell>
        </Table.Row>
      {:else if users.length === 0}
        <Table.Row>
          <Table.Cell colspan={7}>
            <EmptyState
              icon={Search}
              size="sm"
              title={`No users match "${filterQuery}"`}
              description="Try a different search."
            >
              {#snippet action()}
                <Button size="sm" variant="outline" onclick={() => onClearFilter?.()}>Clear search</Button>
              {/snippet}
            </EmptyState>
          </Table.Cell>
        </Table.Row>
      {:else}
        {#each users as user (user.id)}
          <Table.Row>
            <Table.Cell class="font-medium">
              {#if user.name?.trim()}
                {user.name.trim()}
              {:else}
                <span class="italic text-muted-foreground">—</span>
              {/if}
            </Table.Cell>
            <Table.Cell class="font-mono text-xs">{user.username}</Table.Cell>
            <Table.Cell class="hidden text-sm text-muted-foreground lg:table-cell">
              {user.email || "—"}
            </Table.Cell>
            <Table.Cell>
              <RoleBadge role={user.access_level} />
            </Table.Cell>
            <Table.Cell>
              <div class="flex items-center gap-2">
                <Switch
                  checked={user.active}
                  disabled={!canManage || pendingActiveIds.has(user.id)}
                  onCheckedChange={(next) => onToggleActive(user, Boolean(next))}
                  aria-label={user.active ? "Deactivate user" : "Activate user"}
                />
                <span
                  class={cn(
                    "text-xs",
                    user.active ? "text-success" : "text-muted-foreground",
                  )}
                >
                  {user.active ? "Active" : "Inactive"}
                </span>
              </div>
            </Table.Cell>
            <Table.Cell class="hidden text-sm xl:table-cell">
              {#if user.last_login_at}
                <span title={absoluteTime(user.last_login_at)}>
                  {relativeTime(user.last_login_at)}
                </span>
              {:else}
                <span class="text-muted-foreground">Never</span>
              {/if}
            </Table.Cell>
            <Table.Cell>
              <div class="flex justify-end gap-1">
                {#if canManage}
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-8 w-8"
                    aria-label="Edit user"
                    onclick={() => onEdit(user)}
                  >
                    <Pencil class="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label="Delete user"
                    onclick={() => onDelete(user)}
                  >
                    <Trash2 class="h-4 w-4" />
                  </Button>
                {:else}
                  <span class="text-xs text-muted-foreground">read-only</span>
                {/if}
              </div>
            </Table.Cell>
          </Table.Row>
        {/each}
      {/if}
    </Table.Body>
  </Table.Root>
</div>
