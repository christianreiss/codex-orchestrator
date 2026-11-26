<script lang="ts">
  /**
   * The Overview's "Needs you" list (see needs-you.ts for what is counted).
   * Every query here is one the owning page or the shell already runs, under
   * the same key, so this adds no polling and no event listener of its own:
   * the shared live-update invalidations keep it current.
   */
  import { base } from "$app/paths";
  import { createQuery } from "@tanstack/svelte-query";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import Info from "@lucide/svelte/icons/info";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte";
  import { authStore } from "$lib/stores/auth";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import { insecureApprovalsPendingQuery } from "$lib/api/overview";
  import { insecureSummaryQuery } from "$lib/api/insecure";
  import { isInsecureWindowActive } from "$lib/api/hosts";
  import { feedbackApi, feedbackKeys } from "$lib/api/feedback";
  import { agentSessionsQueryOptions, type AgentSessionsResponse } from "$lib/api/agentSessions";
  import { accountsQuery } from "$lib/api/accounts";
  import { createRunnerStateQuery } from "$lib/api/runner";
  import { nearQuotaCounted, needsAttention } from "$lib/components/accounts/account-state";
  import { clientClock, countAwaitingAnswer } from "$lib/portal/clients";
  import { failedRunnerEngines } from "./runner-state";
  import { needsYou, type NeedsYouId, type Source } from "./needs-you";
  import { cn } from "$lib/utils/cn";

  const auth = $derived($authStore);
  const fleet = useFleetEngines();

  const canReadHosts = $derived(auth.can("hosts.read"));
  const canReadAgents = $derived(auth.can("agent_portal.read"));
  const canReadFeedback = $derived(auth.can("feedback.read"));

  // Same keys as the rail alert, top bar, Agents, Accounts and Runner views.
  const approvals = insecureApprovalsPendingQuery();
  const access = insecureSummaryQuery();
  const accounts = accountsQuery();
  const runner = createRunnerStateQuery();
  const feedback = createQuery(
    reactiveOptions(() => ({ queryKey: [...feedbackKeys.summary], queryFn: () => feedbackApi.summary(), enabled: canReadFeedback })),
  );
  const sessions = createQuery<AgentSessionsResponse>(
    reactiveOptions(() => ({ ...agentSessionsQueryOptions(), enabled: canReadAgents })),
  );

  // Presence ages with time, so the waiting count is re-read twice a minute.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  type Readable<D> = { isPending: boolean; isError: boolean; data: D | undefined };
  function read<D, T>(allowed: boolean, query: Readable<D>, pick: (data: D) => T): Source<T> {
    if (!allowed) return { status: "hidden" };
    if (query.isError) return { status: "error" };
    if (query.data === undefined) return { status: "pending" };
    return { status: "ok", value: pick(query.data) };
  }

  const list = $derived(
    needsYou({
      approvals: read(canReadHosts, $approvals, (data) => data.requests?.length ?? 0),
      agents: $sessions.data?.enabled === false
        ? { status: "hidden" }
        : read(canReadAgents, $sessions, (data) => countAwaitingAnswer(data.sessions ?? [], clientClock(data, $sessions.dataUpdatedAt, now), data.timings ?? {})),
      access: read(canReadHosts, $access, (data) => ({
        windows: (data.hosts ?? []).filter((host) => isInsecureWindowActive(host)).length,
        fleetUntil: data.fleet_window?.open ? (data.fleet_window.until ?? null) : null,
      })),
      runner: read(auth.can("admin.read"), $runner, (data) => failedRunnerEngines(data.runner, $fleet.enabled).length),
      accounts: read(auth.can("auth.read_metadata"), $accounts, (data) => {
        const rows = (data.accounts ?? []).filter((account) => $fleet.isEnabled(account.engine));
        // Pool-aware like the Accounts page: a high account is not waiting on anyone while another usable account of its engine has headroom.
        const high = new Set(nearQuotaCounted(rows).map((account) => account.id));
        return {
          attention: rows.filter(needsAttention).length,
          nearQuota: high.size,
          either: rows.filter((account) => needsAttention(account) || high.has(account.id)).length,
        };
      }),
      feedback: read(canReadFeedback, $feedback, (data) => data.open ?? 0),
    }),
  );

  const failedText = $derived(new Intl.ListFormat("en", { type: "conjunction" }).format(list.failed.map((entry) => entry.label)));

  function retry(): void {
    const refetch: Record<NeedsYouId, () => unknown> = {
      approvals: () => $approvals.refetch(),
      agents: () => $sessions.refetch(),
      access: () => $access.refetch(),
      runner: () => $runner.refetch(),
      accounts: () => $accounts.refetch(),
      feedback: () => $feedback.refetch(),
    };
    for (const entry of list.failed) void refetch[entry.id]();
  }
</script>

<Section title="Needs you">
  {#if list.rows.length}
    <ul class="divide-y rounded-md border" aria-label="Waiting on you">
      {#each list.rows as row (row.id)}
        <li>
          <a
            href={`${base}${row.href}`}
            class="flex items-center gap-3 px-3 py-2.5 text-body outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            data-tone={row.tone}
          >
            {#if row.tone === "info"}
              <Info class="h-4 w-4 shrink-0 text-info" aria-hidden="true" />
            {:else}
              <TriangleAlert class={cn("h-4 w-4 shrink-0", row.tone === "danger" ? "text-destructive" : "text-warning")} aria-hidden="true" />
            {/if}
            <span class="min-w-0 flex-1">
              <span class="block">{row.text}</span>
              {#if row.detail}<span class="block text-body-sm text-muted-foreground">{row.detail}</span>{/if}
            </span>
            <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
  {#if list.failed.length}
    <p class={cn("flex flex-wrap items-center gap-2 text-body-sm text-warning", list.rows.length && "mt-2")} role="alert">
      Could not check {failedText}, so something waiting there may not be listed.
      <Button size="sm" variant="outline" onclick={retry}>Retry</Button>
    </p>
  {:else if list.calm}
    <p class="flex items-center gap-2 text-body text-muted-foreground"><CircleCheck class="h-4 w-4 text-success" aria-hidden="true" /> Nothing needs you right now.</p>
  {:else if list.pending && !list.rows.length}
    <p class="text-body-sm text-muted-foreground">Checking what needs you…</p>
  {/if}
</Section>
