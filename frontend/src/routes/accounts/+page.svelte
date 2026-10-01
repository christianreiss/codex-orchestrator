<script lang="ts">
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

  const query = accountsQuery();
  const qc = useQueryClient();
  const canManage = $derived($authStore.can("auth.manage"));
  let engine = $state<AuthEngine>("codex");
  let dialog = $state(false);
  let target = $state<ProviderAccount | null>(null);
  let label = $state("");
  let renaming = $state<number | null>(null);
  let renameLabel = $state("");
  const visible = $derived(($query.data?.accounts ?? []).filter((a) => a.engine === engine));

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
  <PageHeader title="Accounts" subtitle="ChatGPT and Claude accounts shared by the fleet. New sessions automatically use an account with more quota available." />
  <div class="flex flex-wrap items-center gap-2">
    <Button variant={engine === "codex" ? "default" : "outline"} onclick={() => engine = "codex"}>ChatGPT</Button>
    <Button variant={engine === "claude" ? "default" : "outline"} onclick={() => engine = "claude"}>Claude</Button>
    {#if canManage}<Button class="ml-auto" onclick={() => open(null)}>Add account</Button>{/if}
  </div>
  <p class="text-sm text-muted-foreground">Accounts stay fixed during a session. Overlapping sessions using the same local credentials share one account. Fresh logins keep the sole or assigned account. Use Add account for additional subscriptions.</p>
  {#if $query.isPending}
    <p class="text-muted-foreground">Loading accounts…</p>
  {:else if $query.error}
    <div role="alert" class="rounded-lg border border-destructive p-4">{$query.error.message}<Button variant="outline" class="ml-3" onclick={() => $query.refetch()}>Retry</Button></div>
  {:else if !visible.length}
    <div class="rounded-xl border border-dashed p-10 text-center">
      <h2 class="text-lg font-semibold">No {engine === "codex" ? "ChatGPT" : "Claude"} accounts</h2>
      <p class="mt-2 text-sm text-muted-foreground">Add credentials here or log in through {engine === "codex" ? "cdx" : "clx"} on a registered host.</p>
      {#if canManage}<Button class="mt-4" onclick={() => open(null)}>Add account</Button>{/if}
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
              <p class="text-xs text-muted-foreground">Account #{account.id} · {account.state} · auth {account.verification_state}</p>
            </div>
            <span class:!text-destructive={account.verification_state === "failed"} class="text-xs text-muted-foreground">{account.sessions.length} active sessions</span>
          </div>
          {#if account.verification_reason}<p class="text-sm text-destructive">{account.verification_reason}</p>{/if}
          <div class="grid grid-cols-2 gap-4">
            {#each [{ label: "Short window", used: account.usage.short_used_percent, reset: account.usage.short_resets_at }, { label: "Weekly window", used: account.usage.weekly_used_percent, reset: account.usage.weekly_resets_at }] as window}
              <div>
                <div class="mb-1 flex justify-between text-sm"><span>{window.label}</span><strong>{window.used === null ? "Unknown" : `${window.used}%`}</strong></div>
                <progress class="h-2 w-full accent-primary" max="100" value={window.used ?? 0} aria-label={`${window.label} usage`} aria-valuetext={window.used === null ? "Unknown" : `${window.used}%`}></progress>
                <p class="mt-1 text-xs text-muted-foreground">Resets: {date(window.reset)}</p>
              </div>
            {/each}
          </div>
          <p class="text-xs text-muted-foreground">Usage: {date(account.usage.fetched_at)}{account.usage.stale ? " · stale or unavailable" : ""} · Verified: {date(account.verification_checked_at)}</p>
          {#if account.sessions.length}
            <div class="flex flex-wrap gap-2 text-xs">
              {#each [...new Set(account.sessions.map((s) => s.host_id))] as hostId}{#if hostId === 0}<span>Runner task</span>{:else}<a class="text-primary underline" href={`${base}/hosts/${hostId}`}>Host #{hostId}</a>{/if}{/each}
            </div>
          {/if}
          {#if canManage && account.state !== "removing"}
            <div class="flex flex-wrap gap-2 border-t pt-3">
              <Button size="sm" variant="outline" onclick={() => { renaming = account.id; renameLabel = account.label; }}>Rename</Button>
              <Button size="sm" variant="outline" onclick={() => open(account)}>Replace credentials</Button>
              <Button size="sm" variant="outline" disabled={$change.isPending} onclick={() => $change.mutate({ account, action: "verify" })}>Verify</Button>
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
    <Dialog.Header><Dialog.Title>{target ? `Replace ${target.label} credentials` : `Add ${engine === "codex" ? "ChatGPT" : "Claude"} account`}</Dialog.Title><Dialog.Description>Credentials are verified before they can be assigned to clients.</Dialog.Description></Dialog.Header>
    {#if !target}<div class="space-y-2"><Label for="account-label">Account name</Label><Input id="account-label" bind:value={label} maxlength={191} placeholder="Account name (optional)" /></div>{/if}
    {#key dialog}
      {#if dialog}<SeedAuthPanel allowedEngines={[target?.engine ?? engine]} defaultEngine={target?.engine ?? engine} accountId={target?.id} accountLabel={target ? undefined : label.trim() || undefined} accountManagement onStored={() => { dialog = false; void qc.invalidateQueries({ queryKey: accountsKeys.all() }); }} />{/if}
    {/key}
  </Dialog.Content>
</Dialog.Root>
