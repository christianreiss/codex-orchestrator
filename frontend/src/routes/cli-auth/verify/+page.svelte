<script lang="ts">
  import BrandMark from "$lib/components/brand/BrandMark.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Alert, AlertDescription } from "$lib/components/ui/alert";
  import { Label } from "$lib/components/ui/label";
  import { AuthShell } from "$lib/components/page";
  import Check from "@lucide/svelte/icons/check";
  import XCircle from "@lucide/svelte/icons/x-circle";
  import Loader2 from "@lucide/svelte/icons/loader-2";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import { ApiError } from "$lib/api/client";
  import {
    approveCliAuth,
    denyCliAuth,
    isCodeComplete,
    lookupCliAuth,
  } from "$lib/api/cli-auth";
  import type { CliAuthLookup } from "$lib/api/types";
  import CodeInput from "$lib/components/cli-auth/CodeInput.svelte";
  import SessionDetails from "$lib/components/cli-auth/SessionDetails.svelte";

  type Phase = "code" | "confirm" | "approved" | "denied";

  let code = $state("");
  let phase = $state<Phase>("code");
  let session = $state<CliAuthLookup | null>(null);

  let looking = $state(false);
  /** Tracks which side is in-flight so only that button shows a spinner. */
  let acting = $state<null | "approve" | "deny">(null);
  let lookupError = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  /** Distinguishes "not found / expired" so we can show a softer retry CTA. */
  let lookupFailureKind = $state<"unknown" | "not_found" | "expired" | "consumed" | null>(null);

  const codeReady = $derived(isCodeComplete(code));
  const busy = $derived(acting !== null);
  const canApprove = $derived(phase === "confirm" && session !== null && !busy);

  async function doLookup() {
    if (!codeReady || looking) return;
    lookupError = null;
    lookupFailureKind = null;
    looking = true;
    try {
      const data = await lookupCliAuth(code);
      session = data;
      phase = "confirm";
    } catch (err) {
      session = null;
      if (err instanceof ApiError) {
        lookupError = err.message;
        if (err.status === 404) lookupFailureKind = "not_found";
        else if (err.status === 410) lookupFailureKind = "expired";
        else if (err.status === 409) lookupFailureKind = "consumed";
        else lookupFailureKind = "unknown";
      } else {
        lookupError = "Could not look up the device code. Please try again.";
        lookupFailureKind = "unknown";
      }
    } finally {
      looking = false;
    }
  }

  async function doApprove() {
    if (!canApprove) return;
    actionError = null;
    acting = "approve";
    try {
      await approveCliAuth(code);
      phase = "approved";
    } catch (err) {
      actionError =
        err instanceof ApiError ? err.message : "Approving the session failed. Try again.";
      // 404 / 410 mean the code is no longer usable — surface so user can retry.
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        // Reset back to code entry so the user can try again with a fresh code.
        session = null;
        phase = "code";
        code = "";
        lookupError = err.message;
        lookupFailureKind = err.status === 410 ? "expired" : "not_found";
      }
    } finally {
      acting = null;
    }
  }

  async function doDeny() {
    if (phase !== "confirm" || busy) return;
    actionError = null;
    acting = "deny";
    try {
      await denyCliAuth(code);
      phase = "denied";
    } catch (err) {
      actionError =
        err instanceof ApiError ? err.message : "Denying the session failed. Try again.";
    } finally {
      acting = null;
    }
  }

  function reset() {
    code = "";
    session = null;
    phase = "code";
    lookupError = null;
    lookupFailureKind = null;
    actionError = null;
  }

  const description = $derived(
    phase === "code" ? "Enter the device code displayed in your terminal."
      : phase === "confirm" ? "Review the session details before approving access."
      : phase === "approved" ? "The CLI is now authorized."
      : "The login request was rejected.",
  );
</script>

<AuthShell title="Approve CLI session" {description}>
  {#if phase === "code" || phase === "confirm"}
    <form class="space-y-4" onsubmit={(e) => { e.preventDefault(); void doLookup(); }}>
      <div class="space-y-1.5">
        <Label for="cliAuthCode">Device code</Label>
        <CodeInput bind:value={code} autofocus disabled={phase === "confirm" || looking} onSubmit={doLookup} />
        <p class="text-caption text-muted-foreground">
          Four letters, a dash, and four digits. E.g. <span class="font-mono">ABCD-1234</span>.
        </p>
      </div>

      {#if lookupError}
        <Alert variant="destructive">
          <XCircle class="h-4 w-4" />
          <AlertDescription class="flex flex-col gap-1">
            <span>{lookupError}</span>
            {#if lookupFailureKind === "not_found" || lookupFailureKind === "expired" || lookupFailureKind === "consumed"}
              <span class="text-body-sm opacity-90">
                Restart <span class="font-mono">codex auth</span> on the host to generate a new code, then enter it here.
              </span>
            {/if}
          </AlertDescription>
        </Alert>
      {/if}

      {#if phase === "code"}
        <Button type="submit" class="w-full" disabled={!codeReady || looking}>
          {#if looking}<Loader2 class="h-4 w-4 animate-spin" /> Looking up…{:else}Look up <ArrowRight class="h-4 w-4" />{/if}
        </Button>
      {/if}
    </form>

    {#if phase === "confirm" && session}
      <div class="mt-4 space-y-4">
        <SessionDetails {session} />

        {#if actionError}
          <Alert variant="destructive"><XCircle class="h-4 w-4" /><AlertDescription>{actionError}</AlertDescription></Alert>
        {/if}

        <div class="grid grid-cols-2 gap-2">
          <Button type="button" variant="destructive" disabled={busy} onclick={doDeny}>
            {#if acting === "deny"}<Loader2 class="h-4 w-4 animate-spin" />{:else}<XCircle class="h-4 w-4" />{/if}
            Deny
          </Button>
          <Button type="button" class="bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success" disabled={!canApprove} onclick={doApprove}>
            {#if acting === "approve"}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Check class="h-4 w-4" />{/if}
            Approve
          </Button>
        </div>

        <button type="button" class="block w-full text-center text-body-sm text-muted-foreground underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50" onclick={reset} disabled={busy}>
          Use a different code
        </button>
      </div>
    {/if}
  {:else if phase === "approved"}
    <div class="flex flex-col items-center gap-3 py-2 text-center">
      <div class="flex h-12 w-12 items-center justify-center rounded-full bg-success-muted text-success"><Check class="h-6 w-6" /></div>
      <p class="text-h3">Session approved</p>
      <p class="text-body-sm text-muted-foreground">
        {session?.fqdn ? `${session.fqdn} is now registered.` : "The CLI is now authorized."} You can close this tab.
      </p>
    </div>
  {:else}
    <div class="flex flex-col items-center gap-3 py-2 text-center">
      <div class="flex h-12 w-12 items-center justify-center rounded-full bg-destructive-muted text-destructive"><XCircle class="h-6 w-6" /></div>
      <p class="text-h3">Session denied</p>
      <p class="text-body-sm text-muted-foreground">
        The login request was rejected. The CLI on
        {#if session?.fqdn}<span class="font-mono">{session.fqdn}</span>{:else}the requesting host{/if}
        will stop polling shortly.
      </p>
      <Button type="button" variant="outline" onclick={reset}><RefreshCw class="h-4 w-4" /> Approve another session</Button>
    </div>
  {/if}

  {#snippet footer()}
    <p class="text-center text-body-sm text-muted-foreground">
      You are approving a CLI device-code login. Only continue if you started this flow yourself.
    </p>
    <p class="flex items-center justify-center gap-2 text-body-sm text-muted-foreground">
      <BrandMark class="h-5 w-5" /> Codex Orchestrator
    </p>
  {/snippet}
</AuthShell>
