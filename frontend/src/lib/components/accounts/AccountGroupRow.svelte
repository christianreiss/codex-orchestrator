<script lang="ts">
  /**
   * Header row of one engine's account group, shared by Accounts and the Overview usage table:
   * provider, account count, pool state (problems first; near quota only when no usable account
   * has headroom), least-used account and window averages with their coverage, and for Claude
   * (the engine that switches live) the distribution policy. The toggle is a labelled button
   * with `aria-expanded`; the account rows follow as sibling rows.
   *
   * With `trailing`, the header is laid out like an account row instead of one spanning cell
   * (Overview): Account (toggle, engine, account count), Status (pool state, sessions), then the
   * caller's cells, so a collapsed engine shows its pool meters in the same columns. Details (each
   * account, the policy) come with expanding, or on Accounts.
   */
  import type { Snippet } from "svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { derived, toStore } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { accountsApi, accountsKeys } from "$lib/api/accounts";
  import { ENGINE_META } from "$lib/constants/engines";
  import { cn } from "$lib/utils/cn";
  import { poolState, poolUsageText, type EnginePool } from "./account-state";
  import { policySummary } from "./account-policy";

  type Props = {
    pool: EnginePool;
    /** Columns of the surrounding table; the header spans all of them. */
    columns: number;
    open: boolean;
    /** Held open by a search or engine filter: the toggle is inert until the filter is cleared. */
    forced?: boolean;
    onToggle: () => void;
    /** The cells after Account and Status; given, the header becomes a row like an account's. */
    trailing?: Snippet<[EnginePool]>;
  };
  let { pool, columns, open, forced = false, onToggle, trailing }: Props = $props();

  const meta = $derived(ENGINE_META[pool.engine]);
  const state = $derived(poolState(pool));
  const usage = $derived(poolUsageText(pool));
  const counts = $derived(`${pool.accounts.length} accounts${pool.usable.length < pool.accounts.length ? `, ${pool.usable.length} usable` : ""}`);
  const sessions = $derived(pool.accounts.reduce((sum, account) => sum + account.sessions.length, 0));
  // Same key as the policy section, so accounts.updated keeps it current.
  // Only the spanning header shows it; the row layout leaves the policy to Accounts.
  const policy = createQuery(derived(toStore(() => ({ engine: pool.engine, shown: !trailing })), ({ engine, shown }) => ({ queryKey: accountsKeys.policy(engine), queryFn: () => accountsApi.policy(engine), enabled: shown && engine === "claude" })));
  const policyText = $derived(pool.engine === "claude" ? policySummary($policy.data) : "");
</script>

{#snippet toggleButton(stacked: boolean)}
  <button
    type="button"
    class={cn(
      "-ml-1 inline-flex min-h-9 gap-2 rounded-md px-1 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
      stacked ? "items-start" : "items-center",
    )}
    aria-expanded={open}
    disabled={forced}
    title={forced ? "Shown while a search or engine filter is active" : undefined}
    onclick={onToggle}
  >
    <ChevronRight class={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", stacked && "mt-0.5", open && "rotate-90")} aria-hidden="true" />
    {#if stacked}
      <span class="grid">
        <span class="flex items-center gap-2"><span class={cn("h-2 w-2 shrink-0 rounded-full", meta.color)} aria-hidden="true"></span>{meta.label}</span>{" "}
        <span class="mt-0.5 text-body-sm font-normal text-muted-foreground">{counts}</span>
      </span>
    {:else}
      <span class={cn("h-2 w-2 shrink-0 rounded-full", meta.color)} aria-hidden="true"></span>
      <span>{meta.label}</span>
      <span class="font-normal text-muted-foreground">{counts}</span>
    {/if}
  </button>
{/snippet}

{#if trailing}
<Table.Row class="bg-muted/40 hover:bg-muted/40" data-testid="account-group">
  <Table.Cell>{@render toggleButton(true)}</Table.Cell>
  <Table.Cell>
    <Badge variant={state.tone}>{state.label}</Badge>
    <p class="mt-0.5 text-body-sm text-muted-foreground">{sessions} active {sessions === 1 ? "session" : "sessions"}</p>
  </Table.Cell>
  {@render trailing(pool)}
</Table.Row>
{:else}
<Table.Row class="bg-muted/40 hover:bg-muted/40" data-testid="account-group">
  <Table.Cell colspan={columns} class="py-1.5">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      {@render toggleButton(false)}
      <Badge variant={state.tone}>{state.label}</Badge>
      {#if usage}<span class="text-body-sm text-muted-foreground">{usage}</span>{/if}
      {#if policyText}<span class="text-body-sm text-muted-foreground">Policy: {policyText}</span>{/if}
    </div>
  </Table.Cell>
</Table.Row>
{/if}
