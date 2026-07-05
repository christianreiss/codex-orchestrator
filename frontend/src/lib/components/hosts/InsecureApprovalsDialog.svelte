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
  } from "$lib/api/insecure";
  import InsecureCountdown from "./InsecureCountdown.svelte";
  import InsecureWindowPopover from "./InsecureWindowPopover.svelte";
  import ShieldOff from "@lucide/svelte/icons/shield-off";
  import Globe from "@lucide/svelte/icons/globe";
  import Check from "@lucide/svelte/icons/check";
  import X from "@lucide/svelte/icons/x";
  import Bell from "@lucide/svelte/icons/bell";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  let { open = $bindable(false), onOpenChange }: Props = $props();

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
        Pending approval requests auto-deny after 5 minutes. Open insecure
        windows and active domain allow-lists keep their configured expiry.
      </Dialog.Description>
    </Dialog.Header>

    <div class="max-h-[70vh] space-y-6 overflow-y-auto py-2">
      {#if notifPermission === "default"}
        <div
          class="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
        >
          <div class="flex items-center gap-2 text-amber-700 dark:text-amber-300">
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
      {:else if $approvals.data?.requests && $approvals.data.requests.length > 0}
        <section class="space-y-2">
          <header class="flex items-center justify-between">
            <h3 class="text-sm font-semibold">Pending requests</h3>
            <span class="text-xs text-muted-foreground">{$approvals.data.requests.length}</span>
          </header>
          <ul class="divide-y rounded-md border">
            {#each $approvals.data.requests as req (req.id)}
              <li class="flex items-center justify-between gap-3 px-3 py-2">
                <div class="min-w-0">
                  <div class="truncate text-sm font-medium">{req.fqdn}</div>
                  <div class="truncate text-[11px] text-muted-foreground">
                    from {req.request_ip ?? "unknown"} · #{req.id}
                  </div>
                </div>
                <div class="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={() => run("Domain allowed", $allowDomain.mutateAsync({ id: req.id }))}
                  >
                    <Globe class="h-3.5 w-3.5" /> Allow domain
                  </Button>
                  <Button
                    size="sm"
                    onclick={() => run("Approved", $approve.mutateAsync({ id: req.id }))}
                  >
                    <Check class="h-3.5 w-3.5" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => run("Denied", $deny.mutateAsync({ id: req.id }))}
                  >
                    <X class="h-3.5 w-3.5" />
                  </Button>
                </div>
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
              disabled={!$summary.data?.hosts.length}
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
                    Expires <InsecureCountdown until={d.enabled_until} />
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
