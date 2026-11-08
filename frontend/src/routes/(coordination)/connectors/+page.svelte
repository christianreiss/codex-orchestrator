<script lang="ts">
  import {
    createMutation,
    createQuery,
    useQueryClient,
  } from "@tanstack/svelte-query";
  import { derived, toStore } from "svelte/store";
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/api/client";
  import {
    connectorConfig,
    connectorConnections,
    emptyScope,
    type Scope,
    type Policy,
  } from "$lib/api/connectors";
  import { PageShell, Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import Timestamp from "$lib/components/page/Timestamp.svelte";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import ScopeEditor from "$lib/components/connectors/ScopeEditor.svelte";
  const config = connectorConfig(),
    connections = connectorConnections(),
    client = useQueryClient();
  let draft = $state<Policy | null>(null),
    consentScope = $state(emptyScope()),
    provider = $state<"chatgpt" | "claude" | "grok">("chatgpt");
  let reviewed = $state<{
      scope: Scope;
      operations: string[];
      input: string;
      request: string | null;
    } | null>(null),
    callback = $state(""),
    manualClient = $state<{
      id: string;
      provider: string;
      callback: string;
    } | null>(null);
  const preview = createMutation({
    mutationFn: (input: {
      scope: Scope;
      fingerprint: string;
      request: string | null;
    }) =>
      api.post<{ scope: Scope; operations: string[] }>(
        "/admin/connectors/preview",
        input.scope,
      ),
    onSuccess: (data, input) => {
      if (
        input.request === request &&
        input.fingerprint === JSON.stringify(consentScope)
      )
        reviewed = {
          ...data,
          input: input.fingerprint,
          request: input.request,
        };
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });
  function review() {
    const scope = JSON.parse(JSON.stringify(consentScope)) as Scope;
    $preview.mutate({ scope, fingerprint: JSON.stringify(scope), request });
  }
  const register = createMutation({
    mutationFn: (input: { provider: string; redirect_uri: string }) =>
      api.post<{ client_id: string }>("/admin/connectors/clients", input),
    onSuccess: (data, input) =>
      (manualClient = {
        id: data.client_id,
        provider: input.provider,
        callback: input.redirect_uri,
      }),
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });
  const request = $derived(page.url.searchParams.get("request"));
  const consent = createQuery(
    derived(
      toStore(() => request),
      (request) => ({
        queryKey: ["connectors", "consent", request],
        enabled: !!request,
        queryFn: () =>
          api.get<{ client: { name: string; provider: string }; csrf: string }>(
            `/admin/connectors/consent/${request}`,
          ),
      }),
    ),
  );
  const save = createMutation({
    mutationFn: (policy: Policy) => api.put("/admin/connectors/config", policy),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["connectors"] });
      draft = null;
      toast.success("Connector policy saved");
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });
  const revoke = createMutation({
    mutationFn: (id: string) =>
      api.delete(`/admin/connectors/connections/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["connectors"] });
      toast.success("Connection revoked");
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });
  const approve = createMutation({
    mutationFn: (approved: boolean) =>
      api.post<{ redirect: string }>(`/admin/connectors/consent/${request}`, {
        csrf: $consent.data?.csrf,
        scope: reviewed?.scope ?? consentScope,
        approve: approved,
      }),
    onSuccess: (data) => window.location.assign(data.redirect),
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed; select and copy the displayed URL.");
    }
  }
</script>

<DraftGuard
  dirty={!!draft &&
    JSON.stringify(draft) !== JSON.stringify($config.data?.policy)}
/>
<PageShell
  title="Connectors"
  description="Connect chat apps with explicit permissions for your account."
>
  {#if $config.error}<p role="alert">{$config.error.message}</p>
    <Button onclick={() => void $config.refetch()}>Retry</Button>
  {:else if !$config.data}<p role="status">Loading connector settings…</p>
  {:else}
    {@const c = $config.data}
    {#if request}
      <Section
        title="Authorize connection"
        description="Permissions are limited by your account and the administrator policy. New access always needs fresh consent."
      >
        {#if $consent.error}<p role="alert">{$consent.error.message}</p>
          <a href="/admin/connectors">Return to connectors</a>
        {:else if $consent.data}
          <p class="mb-4">
            Client: <strong>{$consent.data.client.name}</strong> ({$consent.data
              .client.provider}). This name is supplied by the OAuth client; it
            is not proof of provider identity.
          </p>
          <fieldset disabled={$approve.isPending}>
            <legend class="font-medium">Requested permissions</legend>
            <ScopeEditor
              bind:value={consentScope}
              hosts={c.hosts}
              projects={c.projects}
            />
            <Button
              class="mt-4"
              variant="outline"
              disabled={$preview.isPending}
              onclick={review}>Review effective permissions</Button
            >
            {#if reviewed && reviewed.request === request && reviewed.input === JSON.stringify(consentScope)}<p
                class="mt-3"
                role="status"
              >
                Effective access: {reviewed.operations.length} tools; {reviewed
                  .scope.hosts.length} hosts; {reviewed.scope.projects.length} projects.
                {reviewed.scope.global
                  ? "Includes fleet-wide data."
                  : "No fleet-wide data."}
              </p>
              <p class="break-words text-body-sm">
                {reviewed.operations.join(", ") ||
                  "No tools permitted by the current policy."}
              </p>{/if}
            {#if $preview.error}<p class="mt-2 text-destructive" role="alert">
                Permission review failed: {$preview.error.message}. Your
                selections are retained; retry the review.
              </p>{/if}
            {#if $approve.error}<p class="mt-2 text-destructive" role="alert">
                Authorization failed: {$approve.error.message}. Your selections
                are retained.
              </p>{/if}
            <div class="mt-4 flex gap-2">
              <Button
                disabled={$approve.isPending ||
                  !c.policy.enabled ||
                  !reviewed ||
                  reviewed.request !== request ||
                  reviewed.input !== JSON.stringify(consentScope)}
                onclick={() => $approve.mutate(true)}
                >Authorize connection</Button
              ><Button
                variant="outline"
                disabled={$approve.isPending}
                onclick={() => $approve.mutate(false)}>Deny</Button
              >
            </div>
          </fieldset>
          {#if $approve.isPending}<p class="mt-2" role="status">
              Authorizing reviewed permissions…
            </p>{/if}
        {:else}<p role="status">Loading authorization request…</p>{/if}
      </Section>
    {:else}
      <Section title="Set up a chat app">
        <label class="block"
          >Chat app <select
            class="m-2 rounded border border-input bg-background p-2"
            bind:value={provider}
            onchange={() => $register.reset()}
            ><option value="chatgpt">ChatGPT</option><option value="claude"
              >Claude</option
            ><option value="grok">Grok</option></select
          ></label
        >
        <p class="my-2" role="status">
          {!c.ready
            ? "Not ready: configure a public HTTPS base URL."
            : !c.policy.enabled
              ? "Connector access is off. An administrator must enable it."
              : !c.policy.providers[provider]
                ? `${provider} connections are disabled.`
                : "Configuration ready. Complete authorization and make a test call to verify the connection."}
        </p>
        <ol class="list-decimal space-y-3 pl-5">
          <li>
            Open {provider === "chatgpt"
              ? "ChatGPT Settings → Apps (enable developer mode where required)"
              : provider === "claude"
                ? "Claude Customize → Connectors → Add custom connector"
                : "grok.com/connectors → New Connector → Custom MCP"}. Workspace
            accounts may need their administrator to add the connector first.
          </li>
          <li>
            Enter a name and this MCP server URL: <code class="break-all"
              >{c.mcp_url}</code
            >
            <Button variant="outline" onclick={() => copy(c.mcp_url)}
              >Copy URL</Button
            >
          </li>
          <li>
            Choose OAuth. Use the app's published identity (CIMD) when offered,
            or automatic client registration. If the app asks for a client ID,
            use Manual OAuth client setup below with its exact callback URL.
            Never enter a fleet host API key.
          </li>
          <li>
            Sign in with your dashboard account. Select the permitted
            categories, hosts and projects, then authorize.
          </li>
          <li>
            Ask the chat app to list authorized hosts or projects. OAuth
            authorization and a successful tool call are separate checks; review
            the connection below.
          </li>
        </ol>
        <p class="mt-3 text-body-sm text-muted-foreground">
          The server must be reachable from the provider's cloud over HTTPS.
          Callback URLs must match exactly. If permissions change, disconnect
          and reconnect.
        </p>
        <details class="mt-4">
          <summary class="cursor-pointer py-2"
            >Manual OAuth client setup</summary
          >
          <p>
            Copy the exact callback URL shown by {provider}. Client secrets are
            not required; PKCE protects the code exchange.
          </p>
          <label class="mt-2 block"
            >Callback URL<input
              class="mt-1 w-full rounded border border-input bg-background p-2"
              type="url"
              bind:value={callback}
              onchange={() => $register.reset()}
            /></label
          ><Button
            class="mt-2"
            disabled={$register.isPending ||
              !callback ||
              !c.policy.enabled ||
              !c.policy.providers[provider]}
            onclick={() =>
              $register.mutate({ provider, redirect_uri: callback })}
            >Create client ID</Button
          >{#if manualClient && manualClient.provider === provider && manualClient.callback === callback}<p
              class="mt-2 break-all"
            >
              Client ID: <code>{manualClient.id}</code>
              <Button
                variant="outline"
                onclick={() => manualClient && copy(manualClient.id)}
                >Copy client ID</Button
              >
            </p>{/if}
          <p class="mt-2 break-all">
            Authorization: <code>{c.issuer}/oauth/authorize</code><br />Token:
            <code>{c.issuer}/oauth/token</code><br />Scope:
            <code>connector</code>
          </p>
          {#if $register.error}<p class="mt-2 text-destructive" role="alert">
              Client creation failed: {$register.error.message}. Check the
              callback and retry.
            </p>{/if}
        </details>
      </Section>
      <Section
        title="Connections"
        description="Revoke access here immediately. Enabling a disabled connector does not restore revoked grants."
      >
        {#if $connections.error}<p role="alert">
            {$connections.error.message}
          </p>{:else if !$connections.data}<p role="status">
            Loading connections…
          </p>{:else if !$connections.data.connections.length}<p>
            No authorized connections yet.
          </p>{:else}
          <ul class="divide-y">
            {#each $connections.data.connections as connection}<li
                class="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <strong>{connection.provider}</strong>
                  <p class="break-all text-body-sm">
                    {connection.id} · {connection.operations.length} tools · user
                    {connection.userId}<br />{#if connection.last_call_at}Last
                      successful tool call: <Timestamp
                        value={connection.last_call_at}
                      />{:else}Authorized; no successful tool call recorded yet.{/if}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={$revoke.isPending}
                  onclick={() => $revoke.mutate(connection.id)}>Revoke</Button
                >
              </li>{/each}
          </ul>
        {/if}
        {#if $revoke.error}<p class="text-destructive" role="alert">
            Revocation failed: {$revoke.error.message}. Access may still be
            active; retry.
          </p>{/if}
      </Section>
      {#if c.can_manage}
        <Section
          title="Administrator policy"
          description="Set the maximum permissions. Saving broader policy never expands existing grants."
        >
          {#if !draft}<p>
              Connector access is {c.policy.enabled ? "on" : "off"}.
            </p>
            <Button
              class="mt-2"
              variant="outline"
              onclick={() => {
                $save.reset();
                draft = structuredClone(c.policy);
              }}>Edit policy</Button
            >{:else}
            <fieldset disabled={$save.isPending} class="space-y-4">
              <legend class="font-medium">Policy permissions</legend>
              <label class="flex min-h-10 items-center gap-2"
                ><input type="checkbox" bind:checked={draft.enabled} />Enable
                connector access (switching off revokes all connections)</label
              >
              {#each ["chatgpt", "claude", "grok"] as p}<label
                  class="flex min-h-10 items-center gap-2"
                  ><input
                    type="checkbox"
                    bind:checked={
                      draft.providers[p as keyof typeof draft.providers]
                    }
                  />Enable {p}</label
                >{/each}
              <ScopeEditor
                bind:value={draft.ceiling}
                hosts={c.hosts}
                projects={c.projects}
              />
              <div class="mt-4 flex gap-2">
                <Button
                  disabled={$save.isPending}
                  onclick={() =>
                    draft && $save.mutate(JSON.parse(JSON.stringify(draft)))}
                  >{$save.isPending ? "Saving policy…" : "Save policy"}</Button
                ><Button
                  variant="outline"
                  disabled={$save.isPending}
                  onclick={() => (draft = null)}>Cancel</Button
                >
              </div>
            </fieldset>
            {#if $save.error}<p class="text-destructive" role="alert">
                Policy save failed: {$save.error.message}. Your draft is
                retained; retry saving.
              </p>{/if}
          {/if}
          {#if $save.isSuccess}<p role="status">
              Policy saved and confirmed by the server.
            </p>{/if}
        </Section>
      {/if}
    {/if}
  {/if}
</PageShell>
