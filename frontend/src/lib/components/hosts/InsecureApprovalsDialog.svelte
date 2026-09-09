<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { browser } from "$app/environment";
  import {
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
    OUTCOME_LABELS,
    type ResolutionOutcome,
  } from "$lib/stores/insecure-resolutions";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    /** WS feed, so resolutions made elsewhere animate here identically. */
    events?: Readable<WsEvent | null>;
  };
  let { open = $bindable(false), onOpenChange, events }: Props = $props();

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

  function handleOpenChange(value: boolean): void {
    open = value;
    onOpenChange?.(value);
  }

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
   * which is the honest outcome: the request is still pending.
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

  type Row = InsecureApprovalRequest & { ghost: ResolutionOutcome | null };

  const rows = $derived.by<Row[]>(() => {
    const live = $approvals.data?.requests ?? [];
    const ghosts = $resolutions;
    const out: Row[] = live.map((r) => ({ ...r, ghost: ghosts.get(r.id)?.outcome ?? null }));
    const seen = new Set(live.map((r) => r.id));
    // Rows the server has already forgotten but whose shadow is still on screen.
    for (const [id, res] of ghosts) {
      if (seen.has(id)) continue;
      const known = lastKnown.get(id);
      if (!known) continue;
      out.push({ ...known, ghost: res.outcome });
    }
    return out.sort((a, b) => a.id - b.id);
  });

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
    return rows.filter((r) => {
      if (r.ghost) return false;
      const f = (r.fqdn ?? "").toLowerCase();
      return f === domain || (f.endsWith(suffix) && f.length > suffix.length);
    }).length;
  }

  // Resolutions that happened anywhere — another operator's tab, a domain sweep,
  // the fleet window, or the server's own 5-minute timeout — land in the same
  // overlay, so a row never simply disappears out from under the operator.
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
          markResolved(payload.request_id, payload.reason === "timeout" ? "timeout" : "denied");
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

  // Browser-notification permission state. Reactive so the inline banner
  // disappears as soon as the user grants/denies.
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
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Insecure access</Dialog.Title>
      <Dialog.Description>
        Pending approval requests auto-deny after 5 minutes. Approving grants 8
        hours; allowing a domain clears every pending request under it.
      </Dialog.Description>
    </Dialog.Header>

    <div class="max-h-[70vh] space-y-6 overflow-y-auto py-2">
      <FleetInsecureWindowCard
        window={fleetWindow}
        openHostCount={$summary.data?.hosts.length ?? 0}
        openDomainCount={$summary.data?.domains_active ?? 0}
        onOpen={(minutes) => $openFleetWindow.mutateAsync({ duration_minutes: minutes })}
        onClose={() => $closeFleetWindow.mutateAsync()}
      />

      {#if notifPermission === "default"}
        <div
          class="flex items-center justify-between gap-3 rounded-md border border-warning/25 bg-warning-muted px-3 py-2 text-xs"
        >
          <div class="flex items-center gap-2 text-warning-muted-foreground">
            <Bell class="h-3.5 w-3.5" />
            <span>Enable browser notifications to hear requests when this tab is in the background.</span>
          </div>
          <Button size="sm" variant="outline" onclick={enableNotifications}>Enable</Button>
        </div>
      {/if}

      <!-- Pending approvals -->
      {#if $approvals.isError}
        <p class="text-xs text-destructive">
          Failed to load pending approval requests. There may be requests awaiting review.
        </p>
      {:else if rows.length > 0}
        <section class="space-y-2">
          <header class="flex items-center justify-between">
            <h3 class="text-sm font-semibold">Pending requests</h3>
            <span class="text-xs text-muted-foreground">
              {rows.filter((r) => !r.ghost).length}
            </span>
          </header>
          <ul class="divide-y rounded-md border">
            {#each rows as req (req.id)}
              <li
                class="flex items-center justify-between gap-3 px-3 py-2 transition-all duration-300"
                class:opacity-45={req.ghost}
                class:grayscale={req.ghost}
                class:pointer-events-none={req.ghost}
                out:slide|local={{ duration: 220 }}
              >
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium" class:line-through={req.ghost}>
                    {req.fqdn}
                  </div>
                  <div class="truncate text-[11px] text-muted-foreground">
                    from {req.request_ip ?? "unknown"} · #{req.id}
                  </div>
                </div>
                {#if req.ghost}
                  <span
                    class="shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground"
                  >
                    {OUTCOME_LABELS[req.ghost]}
                  </span>
                {:else}
                  <div class="flex items-center gap-1">
                    <AllowDomainPopover
                      domain={parentDomain(req.fqdn)}
                      coveredCount={coveredBy(parentDomain(req.fqdn))}
                      onConfirm={({ duration_minutes, permanent }) =>
                        resolve(
                          req.id,
                          "domain",
                          "Domain allowed",
                          $allowDomain.mutateAsync({ id: req.id, duration_minutes, permanent }),
                        )}
                    />
                    <Button
                      size="sm"
                      onclick={() =>
                        resolve(req.id, "approved", "Approved", $approve.mutateAsync({ id: req.id }))}
                    >
                      <Check class="h-3.5 w-3.5" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onclick={() =>
                        resolve(req.id, "denied", "Denied", $deny.mutateAsync({ id: req.id }))}
                    >
                      <X class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- Active windows -->
      <section class="space-y-2">
        <header class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">Active windows</h3>
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
          <p class="text-xs text-destructive">Failed to load active insecure windows.</p>
        {:else if !$summary.data?.hosts.length}
          <p class="text-xs text-muted-foreground">No hosts currently in an insecure window.</p>
        {:else}
          <ul class="divide-y rounded-md border">
            {#each $summary.data.hosts as h (h.id)}
              <li class="flex items-center justify-between gap-3 px-3 py-2">
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium">{h.fqdn}</div>
                  <div class="text-[11px] text-muted-foreground">
                    Closes <InsecureCountdown until={h.insecure_enabled_until} />
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

      <!-- Allowed domains -->
      <section class="space-y-2">
        <header class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">Allowed domains</h3>
          <span class="text-xs text-muted-foreground">
            {$summary.data?.domains_active ?? 0} active
          </span>
        </header>
        {#if $summary.isError}
          <p class="text-xs text-destructive">Failed to load allowed domains.</p>
        {:else if !$summary.data?.domains.length}
          <p class="text-xs text-muted-foreground">No active domain allow-list entries.</p>
        {:else}
          <ul class="divide-y rounded-md border">
            {#each $summary.data.domains as d (d.id)}
              <li class="flex items-center justify-between gap-3 px-3 py-2">
                <div class="min-w-0">
                  <div class="truncate font-mono text-sm">{d.domain}</div>
                  <div class="text-[11px] text-muted-foreground">
                    {#if d.enabled_until === null}
                      Never expires
                    {:else}
                      Expires <InsecureCountdown until={d.enabled_until} />
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
      </section>
    </div>
  </Dialog.Content>
</Dialog.Root>
