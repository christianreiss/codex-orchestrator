<script lang="ts" module>
  /**
   * `triage` is what pops up on its own: only the requests, each one a decision
   * the operator can make in one click. `manage` is the full panel the hosts
   * page opens — requests, open windows, allowed domains — behind tabs.
   */
  export type InsecureDialogMode = "triage" | "manage";
</script>

<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Button } from "$lib/components/ui/button";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { browser } from "$app/environment";
  import {
    insecureKeys,
    insecureSummaryQuery,
    insecureApprovalsQuery,
    createDisableInsecureMutation,
    createEnableInsecureMutation,
    createExtendAllInsecureMutation,
    createDisableAllInsecureMutation,
    createApproveInsecureMutation,
    createDenyInsecureMutation,
    createAllowDomainMutation,
    createRevokeDomainMutation,
    createOpenFleetWindowMutation,
    createCloseFleetWindowMutation,
  } from "$lib/api/insecure";
  import { ApiError } from "$lib/api/client";
  import InsecureCountdown from "./InsecureCountdown.svelte";
  import FleetInsecureWindowCard from "./FleetInsecureWindowCard.svelte";
  import InsecureWindowPopover from "./InsecureWindowPopover.svelte";
  import AllowDomainPopover from "./AllowDomainPopover.svelte";
  import ShieldOff from "@lucide/svelte/icons/shield-off";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import Bell from "@lucide/svelte/icons/bell";

  import { untrack } from "svelte";
  import { slide } from "svelte/transition";
  import type { Readable } from "svelte/store";
  import type { WsEvent } from "$lib/ws/client";
  import type { InsecureApprovalRequest } from "$lib/api/types";
  import {
    resolutions,
    markResolved,
    markResolvedMany,
    clearResolved,
    deniedOutcome,
    OUTCOME_LABELS,
    type ResolutionOutcome,
  } from "$lib/stores/insecure-resolutions";

  type Props = {
    open: boolean;
    mode?: InsecureDialogMode;
    onOpenChange?: (open: boolean) => void;
    /** WS feed, so resolutions made elsewhere animate here identically. */
    events?: Readable<WsEvent | null>;
  };
  let {
    open = $bindable(false),
    mode = $bindable<InsecureDialogMode>("manage"),
    onOpenChange,
    events,
  }: Props = $props();

  /** Server-side TTL of a pending request; only the fallback when `expires_at` is absent. */
  const REQUEST_TTL_MS = 5 * 60_000;

  const qc = useQueryClient();
  const summary = insecureSummaryQuery();
  const approvals = insecureApprovalsQuery();

  const disableHost = createDisableInsecureMutation(qc);
  const enableHost = createEnableInsecureMutation(qc);
  const extendAll = createExtendAllInsecureMutation(qc);
  const disableAll = createDisableAllInsecureMutation(qc);
  const approve = createApproveInsecureMutation(qc);
  const deny = createDenyInsecureMutation(qc);
  const allowDomain = createAllowDomainMutation(qc);
  const revokeDomain = createRevokeDomainMutation(qc);
  const openFleetWindow = createOpenFleetWindowMutation(qc);
  const closeFleetWindow = createCloseFleetWindowMutation(qc);

  // The fleet window is stored state, not a count of rows: it can be open
  // before any host has been stamped, so the card must never inherit the
  // `!hosts.length` guard the bulk buttons below carry.
  const fleetWindow = $derived($summary.data?.fleet_window);
  const fleetWindowOpen = $derived(fleetWindow?.open === true);

  let tab = $state<"requests" | "windows" | "domains">("requests");

  function handleOpenChange(value: boolean): void {
    open = value;
    onOpenChange?.(value);
  }

  // One clock for every countdown and drain bar in the dialog; it only runs
  // while the dialog is open.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  async function run<T>(label: string, p: Promise<T>): Promise<void> {
    try {
      await p;
      toast.success(label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      toast.error(msg);
    }
  }

  /**
   * Resolve a request from this browser: shadow the row first, then send.
   *
   * Marking before the await is the point — the operator's click gets its
   * feedback immediately rather than one round-trip and one refetch later. If
   * the mutation fails the mark is dropped and the row snaps back to actionable,
   * which is the honest outcome: the request is still pending. A 409 is the
   * exception: the server already settled it (timed out, abandoned, or resolved
   * by someone else), so the row stays shadowed and says so.
   */
  async function resolve<T>(
    id: number,
    outcome: ResolutionOutcome,
    label: string,
    p: Promise<T>,
  ): Promise<void> {
    markResolved(id, outcome);
    try {
      await p;
      toast.success(label);
    } catch (err) {
      clearResolved(id);
      if (err instanceof ApiError && err.status === 409) {
        markResolved(id, "gone");
        void qc.invalidateQueries({ queryKey: insecureKeys.approvals() });
        return;
      }
      const msg = err instanceof Error ? err.message : "Action failed";
      toast.error(msg);
    }
  }

  // ─── the pending list, plus the shadows of what was just resolved ─────────

  // Last rows the server gave us, kept so a row can still be rendered after it
  // has dropped out of /pending — which is exactly when its shadow is showing.
  // `untrack` on the read: this effect writes the same state it reads, and
  // without it the write re-triggers the effect forever.
  let lastKnown = $state(new Map<number, InsecureApprovalRequest>());
  $effect(() => {
    const fetched = $approvals.data?.requests;
    if (!fetched?.length) return;
    const next = new Map(untrack(() => lastKnown));
    for (const r of fetched) next.set(r.id, r);
    lastKnown = next;
  });

  type Row = InsecureApprovalRequest & {
    ghost: ResolutionOutcome | null;
    expiresMs: number | null;
  };

  function expiresMs(r: InsecureApprovalRequest): number | null {
    const explicit = r.expires_at ? Date.parse(r.expires_at) : NaN;
    if (Number.isFinite(explicit)) return explicit;
    const requested = r.requested_at ? Date.parse(r.requested_at) : NaN;
    return Number.isFinite(requested) ? requested + REQUEST_TTL_MS : null;
  }

  const rows = $derived.by<Row[]>(() => {
    const live = $approvals.data?.requests ?? [];
    const ghosts = $resolutions;
    const toRow = (r: InsecureApprovalRequest, ghost: ResolutionOutcome | null): Row => {
      const exp = expiresMs(r);
      // Past its deadline is past its deadline, whether or not the refetch that
      // says so has landed yet. The server agrees within one worker tick.
      const expired = !ghost && exp !== null && now >= exp;
      return { ...r, ghost: expired ? "timeout" : ghost, expiresMs: exp };
    };
    const out: Row[] = live.map((r) => toRow(r, ghosts.get(r.id)?.outcome ?? null));
    const seen = new Set(live.map((r) => r.id));
    // Rows the server has already forgotten but whose shadow is still on screen.
    for (const [id, res] of ghosts) {
      if (seen.has(id)) continue;
      const known = lastKnown.get(id);
      if (!known) continue;
      out.push(toRow(known, res.outcome));
    }
    // Someone waiting in a terminal first, then oldest first.
    return out.sort((a, b) => Number(!!b.live) - Number(!!a.live) || a.id - b.id);
  });

  const actionable = $derived(rows.filter((r) => !r.ghost));

  /**
   * The parent domain "Allow domain" would write — the client-side twin of
   * `resolveParentDomain` on the server: strip one label, and refuse anything
   * that would leave a bare registrable-looking name.
   */
  function parentDomain(fqdn: string | null | undefined): string | null {
    if (typeof fqdn !== "string") return null;
    const parts = fqdn.toLowerCase().trim().split(".").filter(Boolean);
    if (parts.length < 3) return null;
    return parts.slice(1).join(".");
  }

  function coveredBy(domain: string | null): number {
    if (!domain) return 0;
    const suffix = `.${domain}`;
    return actionable.filter((r) => {
      const f = (r.fqdn ?? "").toLowerCase();
      return f === domain || (f.endsWith(suffix) && f.length > suffix.length);
    }).length;
  }

  function approveOne(id: number): Promise<void> {
    return resolve(id, "approved", "Approved", $approve.mutateAsync({ id }));
  }

  function denyOne(id: number): Promise<void> {
    return resolve(id, "denied", "Denied", $deny.mutateAsync({ id }));
  }

  async function approveAll(): Promise<void> {
    for (const r of actionable) await approveOne(r.id);
  }

  // ─── formatting ──────────────────────────────────────────────────────────

  function clock(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function askedAgo(r: Row): string {
    const at = r.requested_at ? Date.parse(r.requested_at) : NaN;
    if (!Number.isFinite(at)) return "";
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 10) return "asked just now";
    if (s < 60) return `asked ${s} s ago`;
    return `asked ${Math.floor(s / 60)} min ago`;
  }

  function remainingFraction(r: Row): number {
    if (r.expiresMs === null) return 1;
    return Math.min(1, Math.max(0, (r.expiresMs - now) / REQUEST_TTL_MS));
  }

  // ─── keyboard: one request on screen, one key to decide it ───────────────

  const single = $derived(mode === "triage" && actionable.length === 1 ? actionable[0] : null);

  function onKeydown(e: KeyboardEvent): void {
    if (!single || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest("input, textarea, select, button, a, [contenteditable], [role='dialog'] [role='dialog']")) {
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void approveOne(single.id);
    } else if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      void denyOne(single.id);
    }
  }

  // Resolutions that happened anywhere — another operator's tab, a domain sweep,
  // the fleet window, or the server's own sweep — land in the same overlay, so a
  // row never simply disappears out from under the operator.
  $effect(() => {
    const feed = events;
    if (!feed) return;
    return feed.subscribe((evt) => {
      if (!evt) return;
      const payload = (evt.payload ?? {}) as Record<string, unknown>;
      switch (evt.type) {
        case "insecure.approved":
          markResolved(payload.request_id, "approved");
          break;
        case "insecure.denied":
          markResolved(payload.request_id, deniedOutcome(payload.reason));
          break;
        case "insecure.domain.allowed":
          if (Array.isArray(payload.cleared_request_ids)) {
            markResolvedMany(payload.cleared_request_ids, "domain");
          } else {
            markResolved(payload.request_id, "domain");
          }
          break;
        case "insecure.approval.changed":
          markResolvedMany(payload.cleared_request_ids, "auto");
          break;
        default:
          break;
      }
    });
  });

  // Browser-notification permission state. Reactive so the nudge disappears as
  // soon as the user grants/denies.
  let notifPermission = $state<NotificationPermission | "unsupported">(
    browser && typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  async function enableNotifications(): Promise<void> {
    if (!browser || typeof Notification === "undefined") return;
    try {
      const result = await Notification.requestPermission();
      notifPermission = result;
      if (result === "granted") toast.success("Browser notifications enabled");
    } catch {
      /* ignore */
    }
  }

  const title = $derived.by(() => {
    if (mode === "manage") return "Insecure access";
    if (actionable.length === 1) return `${actionable[0].fqdn || "A host"} is asking for access`;
    if (actionable.length > 1) return `${actionable.length} hosts are asking for access`;
    return "Access requests";
  });
</script>

{#snippet requestCard(req: Row)}
  {@const fraction = remainingFraction(req)}
  {@const left = req.expiresMs === null ? null : req.expiresMs - now}
  {@const domain = parentDomain(req.fqdn)}
  <li
    class="relative overflow-hidden rounded-lg border bg-card transition-[opacity,filter] duration-300"
    class:opacity-50={req.ghost}
    class:grayscale={req.ghost}
    class:pointer-events-none={req.ghost}
    out:slide|local={{ duration: 220 }}
  >
    <div class="space-y-3 p-4">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <p class="flex items-center gap-2">
            <span class="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              {#if req.live && !req.ghost}
                <span
                  class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none"
                ></span>
                <span class="relative inline-flex h-2 w-2 rounded-full bg-success"></span>
              {:else}
                <span class="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground/40"></span>
              {/if}
            </span>
            <span class="truncate text-base font-semibold" class:line-through={req.ghost}>
              {req.fqdn || `Host #${req.host_id}`}
            </span>
          </p>
          <p class="text-xs text-muted-foreground">
            {req.live ? "Waiting in a terminal" : "Nobody is waiting on this one"}{req.request_ip
              ? `, from ${req.request_ip}`
              : ""}{askedAgo(req) ? `, ${askedAgo(req)}` : ""}
          </p>
        </div>
        {#if req.ghost}
          <span class="shrink-0 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground">
            {OUTCOME_LABELS[req.ghost]}
          </span>
        {:else if left !== null}
          <span
            class="shrink-0 text-sm font-medium tabular-nums"
            class:text-destructive={left < 60_000}
            class:text-muted-foreground={left >= 60_000}
            title="Denied automatically when this runs out"
          >
            {clock(left)}
          </span>
        {/if}
      </div>

      {#if !req.ghost}
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" class="grow sm:grow-0" onclick={() => approveOne(req.id)}>
            <Check class="h-3.5 w-3.5" /> Approve for 8 hours
          </Button>
          <AllowDomainPopover
            {domain}
            coveredCount={coveredBy(domain)}
            onConfirm={({ duration_minutes, permanent }) =>
              resolve(
                req.id,
                "domain",
                "Domain allowed",
                $allowDomain.mutateAsync({ id: req.id, duration_minutes, permanent }),
              )}
          />
          <Button size="sm" variant="ghost" class="ml-auto" onclick={() => denyOne(req.id)}>
            <X class="h-3.5 w-3.5" /> Deny
          </Button>
        </div>
      {/if}
    </div>

    <!-- Time left until the server denies it. The one moving thing in the dialog. -->
    {#if !req.ghost}
      <div class="absolute inset-x-0 bottom-0 h-1 bg-muted" aria-hidden="true">
        <div
          class="h-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
          class:bg-warning={left === null || left >= 60_000}
          class:bg-destructive={left !== null && left < 60_000}
          style:width="{fraction * 100}%"
        ></div>
      </div>
    {/if}
  </li>
{/snippet}

{#snippet requestList()}
  {#if $approvals.isError}
    <p class="text-sm text-destructive">
      Pending requests could not be loaded. Hosts may be waiting; reload to try again.
    </p>
  {:else if rows.length > 0}
    <ul class="space-y-2">
      {#each rows as req (req.id)}
        {@render requestCard(req)}
      {/each}
    </ul>
  {:else}
    <p class="py-6 text-center text-sm text-muted-foreground">No host is waiting for access.</p>
  {/if}
{/snippet}

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-xl" onkeydown={onKeydown}>
    <Dialog.Header>
      <Dialog.Title class="pr-8">{title}</Dialog.Title>
      <Dialog.Description>
        {#if mode === "triage"}
          Approving lets the host fetch credentials for 8 hours. Requests nobody answers are denied
          after 5 minutes.
        {:else}
          Requests, hosts with an open window, and domains that are let in without asking.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if mode === "triage"}
      <div class="max-h-[65vh] overflow-y-auto py-1">
        {@render requestList()}
      </div>

      <footer class="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <div class="flex items-center gap-3 text-xs text-muted-foreground">
          {#if single}
            <span><kbd class="rounded border px-1">Enter</kbd> approve, <kbd class="rounded border px-1">D</kbd> deny</span>
          {/if}
          {#if notifPermission === "default"}
            <button
              type="button"
              class="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
              onclick={enableNotifications}
            >
              <Bell class="h-3 w-3" /> Notify me in the background
            </button>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <Button size="sm" variant="ghost" onclick={() => (mode = "manage")}>Manage access</Button>
          {#if actionable.length > 1}
            <Button size="sm" variant="outline" onclick={approveAll}>
              Approve all {actionable.length}
            </Button>
          {/if}
        </div>
      </footer>
    {:else}
      <Tabs.Root value={tab} onValueChange={(v) => (tab = v as typeof tab)}>
        <Tabs.List>
          <Tabs.Trigger value="requests">Requests ({actionable.length})</Tabs.Trigger>
          <Tabs.Trigger value="windows">Windows ({$summary.data?.hosts.length ?? 0})</Tabs.Trigger>
          <Tabs.Trigger value="domains">Domains ({$summary.data?.domains_active ?? 0})</Tabs.Trigger>
        </Tabs.List>

        <div class="mt-4 max-h-[60vh] overflow-y-auto">
          <Tabs.Content value="requests">
            {@render requestList()}
          </Tabs.Content>

          <Tabs.Content value="windows" class="space-y-4">
            <FleetInsecureWindowCard
              window={fleetWindow}
              openHostCount={$summary.data?.hosts.length ?? 0}
              openDomainCount={$summary.data?.domains_active ?? 0}
              onOpen={(minutes) => $openFleetWindow.mutateAsync({ duration_minutes: minutes })}
              onClose={() => $closeFleetWindow.mutateAsync()}
            />
            <section class="space-y-2">
              <header class="flex items-center justify-between">
                <h3 class="text-sm font-semibold">Hosts with an open window</h3>
                <div class="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!$summary.data?.hosts.length}
                    onclick={() => run("All windows extended", $extendAll.mutateAsync())}
                  >
                    Extend all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!$summary.data?.hosts.length && !fleetWindowOpen}
                    onclick={() => run("All windows disabled", $disableAll.mutateAsync())}
                  >
                    <ShieldOff class="h-3.5 w-3.5" /> Disable all
                  </Button>
                </div>
              </header>
              {#if $summary.isLoading}
                <p class="text-xs text-muted-foreground">Loading…</p>
              {:else if $summary.isError}
                <p class="text-xs text-destructive">Open windows could not be loaded.</p>
              {:else if !$summary.data?.hosts.length}
                <p class="text-xs text-muted-foreground">No host has an open window.</p>
              {:else}
                <ul class="divide-y rounded-md border">
                  {#each $summary.data.hosts as h (h.id)}
                    <li class="flex items-center justify-between gap-3 px-3 py-2">
                      <div class="min-w-0">
                        <div class="truncate text-sm font-medium">{h.fqdn}</div>
                        <div class="text-[11px] text-muted-foreground">
                          Closes in <InsecureCountdown until={h.insecure_enabled_until} />
                        </div>
                      </div>
                      <div class="flex items-center gap-1">
                        <InsecureWindowPopover
                          label="Extend"
                          variant="outline"
                          size="sm"
                          heading="Extend insecure window"
                          confirmLabel="Extend"
                          onConfirm={(duration_minutes) =>
                            run(
                              "Window extended",
                              $enableHost.mutateAsync({ id: h.id, duration_minutes }),
                            )}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={fleetWindowOpen}
                          title={fleetWindowOpen
                            ? "Close the fleet window first — this host would be re-opened on its next request"
                            : undefined}
                          onclick={() => run("Window closed", $disableHost.mutateAsync({ id: h.id }))}
                        >
                          Close
                        </Button>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          </Tabs.Content>

          <Tabs.Content value="domains">
            {#if $summary.isError}
              <p class="text-xs text-destructive">Allowed domains could not be loaded.</p>
            {:else if !$summary.data?.domains.length}
              <p class="py-6 text-center text-sm text-muted-foreground">
                No domain is allowed. Use “Allow domain” on a request to let a whole domain in.
              </p>
            {:else}
              <ul class="divide-y rounded-md border">
                {#each $summary.data.domains as d (d.id)}
                  <li class="flex items-center justify-between gap-3 px-3 py-2">
                    <div class="min-w-0">
                      <div class="truncate text-sm font-medium">*.{d.domain}</div>
                      <div class="text-[11px] text-muted-foreground">
                        {#if d.enabled_until === null}
                          Never expires
                        {:else}
                          Expires in <InsecureCountdown until={d.enabled_until} />
                        {/if}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onclick={() => run("Domain revoked", $revokeDomain.mutateAsync({ id: d.id }))}
                    >
                      Revoke
                    </Button>
                  </li>
                {/each}
              </ul>
            {/if}
          </Tabs.Content>
        </div>
      </Tabs.Root>

      {#if notifPermission === "default"}
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onclick={enableNotifications}
        >
          <Bell class="h-3 w-3" /> Notify me about requests while this tab is in the background
        </button>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
