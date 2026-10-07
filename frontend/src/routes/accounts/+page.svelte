<script lang="ts">
  import { ENGINES, ENGINE_META } from "$lib/constants/engines";
  import { base } from "$app/paths";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Dialog from "$lib/components/ui/dialog";
  import SeedAuthPanel from "$lib/components/setup/SeedAuthPanel.svelte";
  import { accountsApi, accountsKeys, accountsQuery, type ProviderAccount } from "$lib/api/accounts";
  import { authStore } from "$lib/stores/auth";
  import type { AuthEngine } from "$lib/api/auth";
  import { Badge } from "$lib/components/ui/badge";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { useFleetEngines, fleetDisabledTitle } from "$lib/engines/fleet-engines";

  const query = accountsQuery();
  const qc = useQueryClient();
  const canManage = $derived($authStore.can("auth.manage"));
  let engine = $state<AuthEngine>("codex");
  let dialog = $state(false);
  let target = $state<ProviderAccount | null>(null);
  let label = $state("");
  let renaming = $state<number | null>(null);
  let renameLabel = $state("");
  const accounts = $derived($query.data?.accounts ?? []);
  const tabbed = $derived(accounts.length > 6);
  const visible = $derived(tabbed ? accounts.filter((a) => a.engine === engine) : accounts);
  // A fleet-disabled engine keeps its accounts, but anything that reaches the
  // provider (add, replace, verify) is refused by the server until it is on.
  const fleet = useFleetEngines();
  const engineOff = $derived(!$fleet.isEnabled(engine));
  const addDisabled = $derived(tabbed ? engineOff : !ENGINES.some((option) => $fleet.isEnabled(option)));
  const offTitle = $derived(addDisabled ? "Enable an engine under Engines before adding an account." : undefined);

  const change = createMutation({
    mutationFn: async (input: { account: ProviderAccount; action: "state" | "rename" | "remove" | "verify"; label?: string }) => {
      const { account, action } = input;
      if (action === "remove") return accountsApi.remove(account.id);
      if (action === "verify") {
        const result = await accountsApi.verify(account.id);
        if (result.verification_state !== "verified") throw new Error(result.reason ?? `Verification ${result.verification_state}`);
        return result;
      }
      return accountsApi.update(account.id, action === "rename" ? { label: input.label } : { state: account.state === "enabled" ? "paused" : "enabled" });
    },
    onSuccess: () => { renaming = null; toast.success("Account updated"); },
    onError: (error) => toast.error(error.message),
    onSettled: () => { void qc.invalidateQueries({ queryKey: accountsKeys.all() }); },
  });

  function open(account: ProviderAccount | null) {
    target = account;
    label = account?.label ?? "";
    dialog = true;
  }
  function remove(account: ProviderAccount) {
    if (window.confirm(`Remove “${account.label}”? New assignments stop immediately. Stored credentials are retired after active sessions finish.`)) {
      void $change.mutateAsync({ account, action: "remove" }).catch(() => {});
    }
  }
  function date(value: string | null) {
    if (!value) return "Unknown";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
  }
</script>

<div class="space-y-6">
  <PageHeader title="Accounts" subtitle="ChatGPT, Claude, and Grok subscription accounts shared by the fleet. New sessions use verified available accounts." />
  <div class="flex flex-wrap items-center gap-2">
    {#if tabbed}{#each ENGINES as option}<Button variant={engine === option ? "default" : "outline"} onclick={() => engine = option} title={$fleet.isEnabled(option) ? undefined : fleetDisabledTitle(ENGINE_META[option].label)}>{ENGINE_META[option].account}{#if !$fleet.isEnabled(option)}<Badge variant="warning" class="ml-1.5">off</Badge>{/if}</Button>{/each}{/if}
    {#if canManage}<Button class="ml-auto" disabled={addDisabled} title={offTitle} onclick={() => open(null)}>Add account</Button>{/if}
  </div>
  {#each (tabbed ? [engine] : ENGINES).filter((option) => !$fleet.isEnabled(option)) as offEngine}
    <Alert variant="warning">
      <AlertTitle>{ENGINE_META[offEngine].label} is disabled fleet-wide</AlertTitle>
      <AlertDescription>
        Its accounts are kept but not refreshed, verified, polled or leased while it is off. Adding,
        replacing and verifying credentials is refused until it is turned back on under Engines. After a
        long pause an account may need its credentials replaced.
      </AlertDescription>
    </Alert>
  {/each}
  <p class="text-sm text-muted-foreground">Accounts stay fixed during a session. Overlapping sessions using the same local credentials share one account. Fresh logins keep the sole or assigned account. Use Add account for additional subscriptions.</p>
  {#if $query.isPending}
    <p class="text-muted-foreground">Loading accounts…</p>
  {:else if $query.error}
    <div role="alert" class="rounded-lg border border-destructive p-4">{$query.error.message}<Button variant="outline" class="ml-3" onclick={() => $query.refetch()}>Retry</Button></div>
  {:else if !visible.length}
    <div class="rounded-xl border border-dashed p-10 text-center">
      <h2 class="text-lg font-semibold">No {tabbed ? `${ENGINE_META[engine].account} ` : ""}accounts</h2>
      <p class="mt-2 text-sm text-muted-foreground">Add credentials here or log in through {tabbed ? ENGINE_META[engine].command : "cdx, clx, or cgx"} on a registered host.</p>
      {#if canManage}<Button class="mt-4" disabled={addDisabled} title={offTitle} onclick={() => open(null)}>Add account</Button>{/if}
    </div>
  {:else}
    <div class="grid gap-4 xl:grid-cols-2">
      {#each visible as account (account.id)}
        <section class="space-y-4 rounded-xl border bg-card p-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              {#if renaming === account.id}
                <form class="flex gap-2" onsubmit={(event) => { event.preventDefault(); $change.mutate({ account, action: "rename", label: renameLabel.trim() }); }}>
                  <Input aria-label="Account name" bind:value={renameLabel} maxlength={191} required />
                  <Button type="submit" disabled={$change.isPending || !renameLabel.trim()}>Save</Button>
                  <Button variant="ghost" onclick={() => renaming = null}>Cancel</Button>
                </form>
              {:else}<h2 class="text-lg font-semibold">{account.label}</h2>{/if}
              <p class="text-xs text-muted-foreground">{ENGINE_META[account.engine].account} · Account #{account.id} · {account.state} · auth {account.verification_state}</p>
            </div>
            {#if !$fleet.isEnabled(account.engine)}<Badge variant="warning" title={fleetDisabledTitle(ENGINE_META[account.engine].label)}>Engine off</Badge>{/if}
            <span class:!text-destructive={account.verification_state === "failed"} class="text-xs text-muted-foreground">{account.sessions.length} active sessions</span>
          </div>
          {#if account.verification_reason}<p class="text-sm text-destructive">{account.verification_reason}</p>{/if}
          {#if account.refresh_state === "login_required"}
            <p role="alert" class="text-sm text-destructive">Subscription login needs renewal. Run {ENGINE_META[account.engine].command} login, then replace the full login credentials.</p>
          {:else if account.refresh_state && account.refresh_state !== "idle"}
            <p class="text-sm text-muted-foreground">Credential refresh: {account.refresh_state.replaceAll("_", " ")}</p>
          {/if}
          {#if account.usage.supported === false}
            <p class="text-sm text-muted-foreground">Subscription quota is unavailable from this provider. Account selection uses verified availability.</p>
          {:else}
          <div class="grid grid-cols-2 gap-4">
            {#each [{ label: "Short window", used: account.usage.short_used_percent, reset: account.usage.short_resets_at }, { label: "Weekly window", used: account.usage.weekly_used_percent, reset: account.usage.weekly_resets_at }] as window}
              <div>
                <div class="mb-1 flex justify-between text-sm"><span>{window.label}</span><strong>{window.used === null ? "Unknown" : `${window.used}%`}</strong></div>
                {#if window.used !== null}<progress class="h-2 w-full accent-primary" max="100" value={window.used} aria-label={`${window.label} usage`} aria-valuetext={`${window.used}%`}></progress>{/if}
                <p class="mt-1 text-xs text-muted-foreground">Resets: {date(window.reset)}</p>
              </div>
            {/each}
          </div>
          {/if}
          <p class="text-xs text-muted-foreground">Usage: {date(account.usage.fetched_at)}{account.usage.stale ? " · stale or unavailable" : ""} · Verified: {date(account.verification_checked_at)}</p>
          {#if account.sessions.length}
            <div class="flex flex-wrap gap-2 text-xs">
              {#each [...new Set(account.sessions.map((s) => s.host_id))] as hostId}{#if hostId === 0}<span>Runner task</span>{:else}<a class="text-primary underline" href={`${base}/hosts/${hostId}`}>Host #{hostId}</a>{/if}{/each}
            </div>
          {/if}
          {#if canManage && account.state !== "removing"}
            <div class="flex flex-wrap gap-2 border-t pt-3">
              <Button size="sm" variant="outline" onclick={() => { renaming = account.id; renameLabel = account.label; }}>Rename</Button>
              <Button size="sm" variant="outline" disabled={!$fleet.isEnabled(account.engine)} title={$fleet.isEnabled(account.engine) ? undefined : fleetDisabledTitle(ENGINE_META[account.engine].label)} onclick={() => open(account)}>Replace credentials</Button>
              <Button size="sm" variant="outline" disabled={$change.isPending || !$fleet.isEnabled(account.engine)} title={$fleet.isEnabled(account.engine) ? undefined : fleetDisabledTitle(ENGINE_META[account.engine].label)} onclick={() => $change.mutate({ account, action: "verify" })}>Verify</Button>
              <Button size="sm" variant="outline" disabled={$change.isPending} onclick={() => $change.mutate({ account, action: "state" })}>{account.state === "enabled" ? "Pause" : "Resume"}</Button>
              <Button size="sm" variant="destructive" disabled={$change.isPending} onclick={() => remove(account)}>Remove</Button>
            </div>
          {:else if account.state === "removing"}<p class="text-sm text-muted-foreground">Removal pending: waiting for active sessions to finish.</p>{/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<Dialog.Root bind:open={dialog}>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <Dialog.Header><Dialog.Title>{target ? `Replace ${target.label} credentials` : tabbed ? `Add ${ENGINE_META[engine].account} account` : "Add account"}</Dialog.Title><Dialog.Description>Credentials are verified before they can be assigned to clients.</Dialog.Description></Dialog.Header>
    {#if !target}<div class="space-y-2"><Label for="account-label">Account name</Label><Input id="account-label" bind:value={label} maxlength={191} placeholder="Account name (optional)" /></div>{/if}
    {#key dialog}
      {#if dialog}<SeedAuthPanel allowedEngines={target ? [target.engine] : tabbed ? [engine] : [...ENGINES]} defaultEngine={target?.engine ?? engine} accountId={target?.id} accountLabel={target ? undefined : label.trim() || undefined} accountManagement onStored={() => { dialog = false; void qc.invalidateQueries({ queryKey: accountsKeys.all() }); }} />{/if}
    {/key}
  </Dialog.Content>
</Dialog.Root>
