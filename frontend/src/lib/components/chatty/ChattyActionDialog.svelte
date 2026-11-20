<script lang="ts">
  import { useQueryClient } from "@tanstack/svelte-query";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { ApiError } from "$lib/api/client";
  import { verifyChattyProposal, type ChattyProposalCheck } from "$lib/api/chatty";
  import { createAutoUpdateToggleMutation, createHostEnginesMutation } from "$lib/api/hosts";
  import { createDisableInsecureMutation } from "$lib/api/insecure";
  import { accountsApi, accountsKeys } from "$lib/api/accounts";
  import { versionsCheckMutation } from "$lib/api/settings";
  import { ACTION_RISK, actionRequest, samePlan, type ActionRequest, type ChattyActionElement } from "./actions";

  /**
   * Confirmation for one Chatty action button. The server re-checks the proposal
   * for this session; the dialog shows its fresh description and, on confirm,
   * calls the same existing admin endpoint (through the same client mutation) the
   * ordinary page uses. Chatty's own server never executes these operations.
   */
  type Outcome = { ok: boolean; text: string };
  type Props = {
    element: ChattyActionElement | null;
    open: boolean;
    onOutcome: (proposal: string, outcome: Outcome) => void;
  };
  let { element, open = $bindable(), onOutcome }: Props = $props();

  type Verified = Extract<ChattyProposalCheck, { available: true }>;
  const qc = useQueryClient();
  const hostEngines = createHostEnginesMutation(qc);
  const autoUpdate = createAutoUpdateToggleMutation(qc);
  const disableInsecure = createDisableInsecureMutation(qc);
  const versionsCheck = versionsCheckMutation();

  let checked = $state<Verified | null>(null);
  let checking = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  /** The server check must describe the clicked action and a request the console allows. */
  function accept(result: ChattyProposalCheck, current: ChattyActionElement): { verified: Verified; request: ActionRequest } | string {
    if (!result.available) return result.detail || "This suggestion is no longer valid. Ask Chatty again.";
    const request = result.action === current.action && result.risk === ACTION_RISK[current.action] ? actionRequest(current.action, result.plan) : null;
    return request ? { verified: result, request } : "The console cannot carry out this suggestion.";
  }

  async function check(current: ChattyActionElement) {
    checking = true; error = null; checked = null;
    try {
      const outcome = accept(await verifyChattyProposal(current.proposal), current);
      if (typeof outcome === "string") error = outcome;
      else checked = outcome.verified;
    } catch (e) {
      error = e instanceof Error ? e.message : "The suggestion could not be checked.";
    } finally {
      checking = false;
    }
  }

  $effect(() => {
    if (open && element) void check(element);
  });

  async function execute(request: ActionRequest): Promise<string> {
    switch (request.kind) {
      case "host-engines":
        await $hostEngines.mutateAsync({ id: request.hostId, engines: request.engines });
        return "done";
      case "host-auto-update":
        await $autoUpdate.mutateAsync({ id: request.hostId, value: request.enabled });
        return "done";
      case "host-insecure-close":
        await $disableInsecure.mutateAsync({ id: request.hostId });
        return "done";
      case "account-verify": {
        const result = await accountsApi.verify(request.accountId);
        void qc.invalidateQueries({ queryKey: accountsKeys.all() });
        return `Check result: ${result.verification_state}${result.reason ? ` (${result.reason})` : ""}`;
      }
      case "versions-check":
        await $versionsCheck.mutateAsync();
        return "done";
    }
  }

  async function confirm() {
    const current = element;
    const shown = checked;
    if (!current || !shown || busy) return;
    busy = true; error = null;
    try {
      // Re-check right before the call: a target that changed since the dialog opened needs a new confirmation.
      const outcome = accept(await verifyChattyProposal(current.proposal), current);
      if (typeof outcome === "string") { error = outcome; checked = null; return; }
      if (!samePlan(outcome.verified.plan, shown.plan) || outcome.verified.title !== shown.title) {
        checked = outcome.verified;
        error = "The state has changed. Review the updated description and confirm again.";
        return;
      }
      let result: string;
      try {
        result = await execute(outcome.request);
      } catch (e) {
        // A refused request did not run; a transport failure or server error has an unknown outcome.
        const refused = e instanceof ApiError && e.status >= 400 && e.status < 500;
        const text = refused
          ? `Not carried out: ${e.message}`
          : "Outcome unknown. Check the current state before you try again.";
        error = text;
        onOutcome(current.proposal, { ok: false, text: `${shown.label}: ${text}` });
        return;
      }
      onOutcome(current.proposal, { ok: true, text: `${shown.label}: ${result}` });
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : "The suggestion could not be checked.";
    } finally {
      busy = false;
    }
  }
</script>

<ConfirmDialog
  bind:open
  title={checked?.title ?? element?.label ?? "Review action"}
  confirmLabel={checked?.confirm_label ?? "Confirm"}
  cancelLabel="Cancel"
  busyLabel="Running…"
  destructive={element?.risk === "danger"}
  {busy}
  confirmDisabled={checking || !checked}
  requireText={checked?.risk === "danger" ? checked.confirm_text : null}
  requireTextLabel="Type the name to confirm"
  {error}
  onConfirm={confirm}
  onClose={() => { checked = null; error = null; }}
>
  <div class="space-y-3 text-body" aria-live="polite">
    {#if checking}
      <p class="text-muted-foreground">Checking the suggestion against the current state…</p>
    {:else if checked}
      {#if checked.target}
        <p><span class="text-muted-foreground">Target:</span> <span class="break-all font-medium">{checked.target.kind === "host" ? "Host" : "Account"} {checked.target.name}</span> <span class="text-muted-foreground">(ID {checked.target.id})</span></p>
      {/if}
      <ul class="list-disc space-y-1 pl-5">
        {#each checked.summary as line}<li class="break-words">{line}</li>{/each}
      </ul>
      <p class="text-body-sm text-muted-foreground">Runs through the same admin function as its page, with your permissions, not through Chatty.</p>
    {/if}
  </div>
</ConfirmDialog>
