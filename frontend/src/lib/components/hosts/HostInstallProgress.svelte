<script lang="ts">
  /**
   * What happens after a host is registered: the installer command, and a
   * live three-step timeline of the install actually landing.
   *
   * Shared by the Hosts page sheet and the setup wizard. Polls the host detail
   * every 5 s while mounted and unfinished (WS `host.updated` invalidates it
   * too); unmounting — closing the sheet, leaving the step — ends the poll.
   *
   * Recovery stays on the same host: a used-but-unsynced or expired token is
   * re-minted through the host's installer endpoint, never by registering a
   * second host.
   */
  import { onMount, untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Check from "@lucide/svelte/icons/check";
  import Circle from "@lucide/svelte/icons/circle";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { ReadonlyCodeBlock } from "$lib/components/ui/code-block";
  import SeedAuthDialog from "./SeedAuthDialog.svelte";
  import { createMintInstallerMutation, hostDetailQuery, hostEngines } from "$lib/api/hosts";
  import { setupStatusQuery } from "$lib/api/setup";
  import { autoCopyText } from "$lib/utils/clipboard";
  import { relativeTime } from "$lib/utils/format";
  import { cn } from "$lib/utils/cn";
  import type { AuthEngine } from "$lib/api/auth";
  import type { HostDetail, InstallerInfo } from "$lib/api/types";

  type Props = {
    hostId: number;
    fqdn: string;
    /** The installer from the register response; replaced on re-mint. */
    installer: InstallerInfo;
    /** Engines requested at registration, until the detail query lands. */
    engines?: string[];
  };

  let { hostId, fqdn, installer, engines: requestedEngines = [] }: Props = $props();

  const qc = useQueryClient();

  function syncedAt(host: HostDetail | undefined): string | null {
    return host?.last_refresh || host?.claude_last_refresh || null;
  }

  // The host is fixed for this instance; containers remount for a new one.
  const detail = hostDetailQuery(
    untrack(() => hostId),
    { refetchInterval: (data) => (syncedAt(data?.host) ? false : 5000) },
  );
  const setup = setupStatusQuery();
  const mint = createMintInstallerMutation(qc);

  let reminted = $state<InstallerInfo | null>(null);
  let seedOpen = $state(false);
  let now = $state(Date.now());

  onMount(() => {
    const timer = window.setInterval(() => (now = Date.now()), 15_000);
    return () => window.clearInterval(timer);
  });

  const host = $derived($detail.data?.host);
  const current = $derived(reminted ?? installer);
  // A re-mint here wins until the detail refetch catches up; otherwise the
  // detail row tracks the newest token, including re-mints made elsewhere.
  const expiresAt = $derived(
    reminted?.expires_at ?? host?.installer_expires_at ?? installer.expires_at ?? null,
  );
  const expired = $derived(expiresAt !== null && Date.parse(expiresAt) <= now);
  const usedAt = $derived(host?.installer_used_at ?? null);
  const installedAt = $derived(host?.last_cron_check ?? null);
  const synced = $derived(syncedAt(host));
  const canRemint = $derived(!synced && (Boolean(usedAt) || expired));

  const engines = $derived(host ? hostEngines(host) : requestedEngines);
  const missingAuth = $derived.by((): AuthEngine[] => {
    const canonical = $setup.data?.canonical_auth;
    if (!canonical) return [];
    return engines.filter(
      (engine): engine is AuthEngine =>
        (engine === "codex" || engine === "claude") && !canonical[engine],
    );
  });

  type Stage = { id: string; label: string; at: string | null; hint: string };
  const stages = $derived<Stage[]>([
    {
      id: "fetched",
      label: "Installer fetched",
      at: usedAt,
      hint: "Run the command above on the host.",
    },
    {
      id: "installed",
      label: "Wrapper installed",
      at: installedAt,
      hint: "The installer reports in once the wrapper is in place.",
    },
    {
      id: "synced",
      label: "First sync",
      at: synced,
      hint: "Happens the first time the wrapper fetches credentials.",
    },
  ]);
  // The first stage without a timestamp is the one being waited on.
  const waitingIndex = $derived(stages.findIndex((stage) => !stage.at));

  async function remint(): Promise<void> {
    try {
      const res = await $mint.mutateAsync({ id: hostId });
      reminted = res.installer;
      now = Date.now();
      await autoCopyText(res.installer.command, "New installer command copied", "New installer minted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mint a new installer");
    }
  }
</script>

<div class="space-y-4">
  {#if expired && !usedAt}
    <Alert variant="warning">
      <AlertTitle>This installer command has expired</AlertTitle>
      <AlertDescription>Mint a new one for the same host below; nothing else changes.</AlertDescription>
    </Alert>
  {/if}

  <ReadonlyCodeBlock
    label="Run this on {fqdn}"
    value={current.command}
    wrap
    rows={3}
    expiresAt={expiresAt ? new Date(expiresAt).toLocaleString() : undefined}
  />
  <p class="text-xs text-muted-foreground">
    It installs the wrapper with this host's address and API key built in. The command works
    once and expires.
  </p>

  <ol class="space-y-0 rounded-lg border p-3" aria-label="Install progress">
    {#each stages as stage, i (stage.id)}
      {@const done = Boolean(stage.at)}
      {@const waiting = i === waitingIndex}
      <li class="flex items-start gap-3 py-1.5">
        <span
          class={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
            done && "border-success/40 bg-success-muted text-success-muted-foreground",
            waiting && "border-primary/40 text-primary",
            !done && !waiting && "border-muted-foreground/30 text-muted-foreground/50",
          )}
          aria-hidden="true"
        >
          {#if done}
            <Check class="h-3 w-3" />
          {:else if waiting}
            <LoaderCircle class="h-3 w-3 animate-spin" />
          {:else}
            <Circle class="h-2 w-2" />
          {/if}
        </span>
        <span class="min-w-0 flex-1">
          <span class={cn("block text-sm", done ? "font-medium" : !waiting && "text-muted-foreground")}>
            {stage.label}
            <span class="sr-only">{done ? "(done)" : waiting ? "(in progress)" : "(pending)"}</span>
          </span>
          <span class="block text-xs text-muted-foreground">
            {#if done && stage.at}
              {relativeTime(stage.at)}
            {:else if waiting}
              {stage.hint}
            {/if}
          </span>
        </span>
      </li>
    {/each}
  </ol>

  <p class="text-xs text-muted-foreground" aria-live="polite">
    {#if synced}
      {fqdn} is set up and syncing.
    {:else if $detail.isError}
      Could not check progress: {$detail.error.message}
    {:else}
      Checking every few seconds while this is open.
    {/if}
  </p>

  {#if missingAuth.length > 0 || canRemint}
    <div class="flex flex-wrap gap-2">
      {#if missingAuth.length > 0}
        <Button variant="outline" size="sm" onclick={() => (seedOpen = true)}>
          <KeyRound class="h-4 w-4" />
          Seed {missingAuth[0] === "claude" ? "Claude" : "Codex"} credentials
        </Button>
      {/if}
      {#if canRemint}
        <Button variant="outline" size="sm" onclick={remint} disabled={$mint.isPending}>
          <RefreshCw class="h-4 w-4" />
          {$mint.isPending ? "Minting…" : "Re-mint installer"}
        </Button>
      {/if}
    </div>
    {#if missingAuth.length > 0}
      <p class="text-xs text-muted-foreground">
        The fleet has no {missingAuth.map((e) => (e === "claude" ? "Claude" : "Codex")).join(" or ")}
        credentials yet, so the host cannot sync until they are seeded.
      </p>
    {/if}
  {/if}
</div>

<SeedAuthDialog bind:open={seedOpen} defaultEngine={missingAuth[0] ?? "codex"} />
