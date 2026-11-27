<script lang="ts">
  /**
   * Live scopes of one engine: one row per host + user + native credential directory. Every
   * session of that user on that host shares the scope's account, so a switch moves them all.
   */
  import { base } from "$app/paths";
  import { derived, toStore } from "svelte/store";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { accountsApi, accountsKeys, type AccountScope, type ProviderAccount } from "$lib/api/accounts";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Table from "$lib/components/ui/table";
  import { Label } from "$lib/components/ui/label";
  import { SimpleSelect } from "$lib/components/ui/select";
  import { Section, DataTable, Timestamp } from "$lib/components/page";
  import { scopePauseStatus, switchTargets } from "./account-policy";

  type Props = { engine: Engine; accounts: readonly ProviderAccount[]; canManage: boolean };
  let { engine, accounts, canManage }: Props = $props();

  const qc = useQueryClient();
  const query = createQuery(derived(toStore(() => engine), (e) => ({ queryKey: accountsKeys.scopes(e), queryFn: () => accountsApi.scopes(e) })));
  const label = $derived(ENGINE_META[engine].label);

  let target = $state<AccountScope | null>(null);
  let choice = $state("");
  const options = $derived(target ? switchTargets(accounts, engine, target.account_id) : []);
  $effect(() => { if (target) choice = ""; });

  const rowKey = (scope: AccountScope) => `${scope.host_id}:${scope.scope_id}`;
  const change = createMutation({
    mutationFn: (input: { scope: AccountScope; account_id: number }) => accountsApi.switchScope({ engine, host_id: input.scope.host_id, scope_id: input.scope.scope_id, account_id: input.account_id }),
    onSuccess: () => { target = null; toast.success("Switch requested. It applies at the next gap between turns, or when the sessions are paused for it."); },
    onError: (error) => toast.error(error.message),
    onSettled: () => { void qc.invalidateQueries({ queryKey: accountsKeys.scopes(engine) }); void qc.invalidateQueries({ queryKey: accountsKeys.all() }); },
  });
  const reasons = { policy: "policy", admin: "an admin", host: "the host", agent: "an agent" } as const;
</script>

<Section title={`Active ${label} scopes`} description="One row per host and user. All sessions of that user on that host share one credential file, so they always run on the same account.">
  <DataTable
    reflow
    items={$query.data}
    loading={$query.isPending}
    error={$query.error ?? null}
    onRetry={() => $query.refetch()}
    key={rowKey}
    emptyTitle="No active scopes"
    emptyDescription={`A scope appears while a ${label} session holds an account on a host.`}
    caption={`Active ${label} scopes`}
  >
    {#snippet head()}
      <Table.Head>Host</Table.Head>
      <Table.Head>Account</Table.Head>
      <Table.Head>Sessions</Table.Head>
      <Table.Head>Pending switch</Table.Head>
      <Table.Head class="w-10"><span class="sr-only">Actions</span></Table.Head>
    {/snippet}
    {#snippet row(scope)}
      <Table.Row>
        <Table.Cell class="min-w-40"><a class="text-primary underline-offset-2 hover:underline" href={`${base}/hosts/${scope.host_id}`}>{scope.host_fqdn}</a></Table.Cell>
        <Table.Cell>
          <div class="font-medium">{scope.account_label}</div>
          {#if scope.bound_at}<div class="text-caption text-muted-foreground">Since <Timestamp value={scope.bound_at} /></div>{/if}
        </Table.Cell>
        <Table.Cell class="whitespace-nowrap text-body-sm"><span class="text-muted-foreground sm:hidden">Sessions:&nbsp;</span>{scope.sessions}</Table.Cell>
        <Table.Cell class="text-body-sm">
          {@const pausing = scopePauseStatus({ pending: scope.account_switch !== null, sessions: scope.sessions, pause: scope.pause })}
          {#if scope.account_switch}
            <Badge variant="warning">To {scope.account_switch.account_label}</Badge>
            <div class="text-caption text-muted-foreground">
              Requested by {reasons[scope.account_switch.reason] ?? scope.account_switch.reason}{#if scope.account_switch.requested_at}{" "}<Timestamp value={scope.account_switch.requested_at} />{/if}{#if !scope.pause?.round}, waiting for a gap between turns{/if}
            </div>
          {:else if !pausing}
            <span class="text-muted-foreground">None</span>
          {/if}
          {#if pausing}
            <!-- Said in words; the tone only adds emphasis (VIS-4). -->
            <div class={pausing.tone === "blocked" ? "text-caption text-foreground" : "text-caption text-muted-foreground"} data-testid="scope-pause-status">
              {pausing.text}{#if pausing.retryAt}{" "}Next attempt <Timestamp value={pausing.retryAt} />.{/if}
            </div>
          {/if}
        </Table.Cell>
        <Table.Cell class="whitespace-nowrap text-right max-sm:text-left">
          {#if canManage}<Button variant="outline" size="sm" onclick={() => (target = scope)}>Switch to…</Button>{/if}
        </Table.Cell>
      </Table.Row>
    {/snippet}
  </DataTable>
</Section>

<Dialog.Root open={target !== null} onOpenChange={(open) => { if (!open) target = null; }}>
  <Dialog.Content size="md">
    <form onsubmit={(event) => { event.preventDefault(); if (target && choice) $change.mutate({ scope: target, account_id: Number(choice) }); }}>
      <Dialog.Header>
        <Dialog.Title>Switch {target?.host_fqdn ?? "scope"} to another account</Dialog.Title>
        <Dialog.Description>
          Now on {target?.account_label}. The switch applies when no session is talking to the model: at the next gap between turns, or while the sessions are paused for it. It moves all {target?.sessions ?? 0} {target?.sessions === 1 ? "session" : "sessions"} of this user on this host. Each session rebuilds its prompt cache once.
        </Dialog.Description>
      </Dialog.Header>
      <div class="my-4 grid gap-1.5">
        <Label for="scope-switch-target">New account</Label>
        <SimpleSelect id="scope-switch-target" class="w-full" bind:value={choice} placeholder={options.length ? "Choose an account" : "No other verified account"} options={options} disabled={options.length === 0} />
        <p class="text-body-sm text-muted-foreground">Only enabled, verified {label} accounts are offered.</p>
      </div>
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (target = null)}>Cancel</Button>
        <Button type="submit" disabled={$change.isPending || !choice}>Request switch</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
