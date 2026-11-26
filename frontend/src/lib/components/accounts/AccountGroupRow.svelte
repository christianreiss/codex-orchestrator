<script lang="ts">
  /**
   * Header row of one engine's account group, shared by Accounts and the Overview usage table:
   * provider, account count, pool state (problems first; near quota only when no usable account
   * has headroom), least-used account and window averages with their coverage, and for Claude
   * (the engine that switches live) the distribution policy. The toggle is a labelled button
   * with `aria-expanded`; the account rows follow as sibling rows.
   */
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { derived, toStore } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import * as Table from "$lib/components/ui/table";
  import { Badge } from "$lib/components/ui/badge";
  import { accountsApi, accountsKeys } from "$lib/api/accounts";
  import { ENGINE_META } from "$lib/constants/engines";
  import { cn } from "$lib/utils/cn";
  import { poolState, poolUsageText, type EnginePool } from "./account-state";

  type Props = {
    pool: EnginePool;
    /** Columns of the surrounding table; the header spans all of them. */
    columns: number;
    open: boolean;
    /** Held open by a search or engine filter: the toggle is inert until the filter is cleared. */
    forced?: boolean;
    onToggle: () => void;
  };
  let { pool, columns, open, forced = false, onToggle }: Props = $props();

  const meta = $derived(ENGINE_META[pool.engine]);
  const state = $derived(poolState(pool));
  const usage = $derived(poolUsageText(pool));
  const counts = $derived(`${pool.accounts.length} accounts${pool.usable.length < pool.accounts.length ? `, ${pool.usable.length} usable` : ""}`);
  // Same key as the policy section, so accounts.updated keeps it current.
  const policy = createQuery(derived(toStore(() => pool.engine), (engine) => ({ queryKey: accountsKeys.policy(engine), queryFn: () => accountsApi.policy(engine), enabled: engine === "claude" })));
  const policyText = $derived.by(() => {
    const value = pool.engine === "claude" ? $policy.data : undefined;
    if (value?.mode === "manual") return "Manual";
    if (value?.mode === "auto") return `Automatic, ${value.strategy === "exhaust" ? "Exhaust" : "Balanced"}`;
    return "";
  });
</script>

<Table.Row class="bg-muted/40 hover:bg-muted/40" data-testid="account-group">
  <Table.Cell colspan={columns} class="py-1.5">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        class="-ml-1 inline-flex min-h-9 items-center gap-2 rounded-md px-1 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        aria-expanded={open}
        disabled={forced}
        title={forced ? "Shown while a search or engine filter is active" : undefined}
        onclick={onToggle}
      >
        <ChevronRight class={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span class={cn("h-2 w-2 shrink-0 rounded-full", meta.color)} aria-hidden="true"></span>
        <span>{meta.label}</span>
        <span class="font-normal text-muted-foreground">{counts}</span>
      </button>
      <Badge variant={state.tone}>{state.label}</Badge>
      {#if usage}<span class="text-body-sm text-muted-foreground">{usage}</span>{/if}
      {#if policyText}<span class="text-body-sm text-muted-foreground">Policy: {policyText}</span>{/if}
    </div>
  </Table.Cell>
</Table.Row>
