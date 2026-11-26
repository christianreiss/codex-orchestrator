<script lang="ts">
  import { formatDateTime } from "$lib/utils/format";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { SimpleSelect } from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { keysApi, keyQueryKeys } from "$lib/api/keys";
  import { apiSurfacesQuery, apiStateQuery, engineStateQuery, apiSurfacesQueryKey } from "$lib/api/settings";
  import type { AdminApiKeyCreated, ApiKeyEngine, ApiBackendEngine, ApiSource, ApiSurfaceRow, CreateApiKeyPayload } from "$lib/api/types";
  import { SOURCE_LABEL } from "$lib/components/provider-keys/provider-key-model";
  import { KEY_SURFACE, FORMAT_LABEL, BACKEND_LABEL, connectionUrls, curlExample } from "./connection";

  type Props = {
    open: boolean;
    defaultEngine?: ApiKeyEngine;
    onOpenChange?: (open: boolean) => void;
  };
  let { open = $bindable(false), defaultEngine = "openai", onOpenChange }: Props = $props();
  const qc = useQueryClient();
  const surfaces = apiSurfacesQuery();
  const engines = engineStateQuery();
  const apiState = apiStateQuery();
  let format = $state<ApiKeyEngine>("openai");
  let backend = $state<ApiBackendEngine | undefined>();
  /** "Answered by": the API default (no pin) or a pinned source. */
  let answer = $state<"default" | ApiSource>("default");
  let name = $state("");
  let expiresEnabled = $state(false);
  let expiresAt = $state("");
  // Gate dismissal synchronously, before mutation observers publish pending.
  let creating = $state(false);
  let issued = $state<AdminApiKeyCreated | null>(null);
  let issuedConnection = $state<{ format: ApiKeyEngine; backend: ApiBackendEngine | null; source: ApiSource | null; baseUrl: string } | null>(null);
  const selected = $derived($surfaces.data?.surfaces.find(row => row.surface === KEY_SURFACE[format]));
  // Older servers omit the source fields: Subscription, no provider keys.
  const defaultSource = (row: ApiSurfaceRow | undefined): ApiSource => row?.source ?? "emulated";
  const providerName = (row: ApiSurfaceRow | undefined) => row?.provider_label ?? "the provider";
  const origin = $derived(typeof window === "undefined" ? "" : window.location.origin);
  const baseUrl = $derived(selected ? `${origin}${selected.base_path}` : "");
  const engineRows = $derived($engines.data?.engines ?? []);
  const engineEnabled = $derived(engineRows.find(row => row.engine === backend)?.enabled === true);
  /** Under API key the provider path is gated by the API's own engine switch (OpenAI by Codex, and so on). */
  const upstreamReady = (row: ApiSurfaceRow | undefined) => Boolean(row && (row.provider_keys?.usable ?? 0) > 0 && engineRows.find(e => e.engine === row.identity_backend)?.enabled === true);
  const upstreamProblem = (row: ApiSurfaceRow | undefined) => !row ? "" : (row.provider_keys?.usable ?? 0) === 0 ? `No usable ${providerName(row)} API key is stored; add one under Provider keys.` : `The ${BACKEND_LABEL[row.identity_backend]} engine is disabled, which also stops the ${providerName(row)} key path.`;
  const effectiveSource = $derived<ApiSource>(answer === "default" ? defaultSource(selected) : answer);
  const pinsUpstream = $derived(answer === "upstream");
  const answerOptions = $derived([
    { value: "default", label: `API default (${SOURCE_LABEL[defaultSource(selected)]})` },
    { value: "emulated", label: "Subscription" },
    { value: "upstream", label: "Provider API key" },
  ]);
  const answerHint = $derived(
    answer === "upstream"
      ? `Always forwarded to ${providerName(selected)} with a stored provider key and billed to that account. The engine is not used.`
      : answer === "emulated"
        ? "Always answered by a subscription engine, even when the API switches to API key."
        : "Follows the API's source, also when it changes later.",
  );
  const setupError = $derived($surfaces.isError || $engines.isError || $apiState.isError);
  const setupReady = $derived.by(() => {
    // Read every query's data before testing readiness. Query observers track
    // accessed fields; short-circuiting can miss a faster query's data update.
    const engineData = $engines.data;
    const stateData = $apiState.data;
    return Boolean(selected && engineData && stateData && !setupError);
  });
  const available = $derived(setupReady && !$apiState.data?.disabled && !selected?.disabled && (effectiveSource === "upstream" ? upstreamReady(selected) : engineEnabled));
  const canSubmit = $derived(Boolean(name.trim()) && setupReady && !creating && (pinsUpstream || (Boolean(backend) && engineEnabled)));
  const connection = $derived(issuedConnection);
  const urls = $derived(connection ? connectionUrls(connection.format, connection.baseUrl) : []);
  const example = $derived(connection && issued ? curlExample(connection.format, connection.baseUrl, issued.key) : "");
  const connectionEngineEnabled = $derived(engineRows.find(row => row.engine === connection?.backend)?.enabled === true);
  const connectionSurface = $derived($surfaces.data?.surfaces.find(row => row.surface === (connection ? KEY_SURFACE[connection.format] : "")));
  const connectionSource = $derived<ApiSource>(connection?.source ?? defaultSource(connectionSurface));
  const availability = $derived(setupError ? "Status unavailable" : !$apiState.data || !connectionSurface || !$engines.data ? "Checking availability…" : $apiState.data.disabled ? "All API traffic is disabled" : connectionSurface.disabled ? "Endpoint is disabled" : connectionSource === "upstream" ? (upstreamReady(connectionSurface) ? "Enabled" : upstreamProblem(connectionSurface)) : !connectionEngineEnabled ? "Assigned engine is disabled" : "Enabled");
  const answeredBy = (source: ApiSource | null, row: ApiSurfaceRow | undefined) =>
    source === "upstream" ? `${providerName(row)} API key` : source === "emulated" ? "Subscription" : `API default (${SOURCE_LABEL[defaultSource(row)]})`;

  const createMut = createMutation<AdminApiKeyCreated, Error, {
    format: ApiKeyEngine; payload: CreateApiKeyPayload; backend: ApiBackendEngine | null; source: ApiSource | null; baseUrl: string;
  }>({
    mutationFn: ({ format, payload }) => keysApi.create(format, payload),
    onSettled: () => { creating = false; },
    onSuccess: (data, vars) => {
      issuedConnection = { format: vars.format, backend: data.record.backend_engine ?? vars.backend, source: data.record.source ?? vars.source, baseUrl: vars.baseUrl };
      issued = data;
      void qc.invalidateQueries({ queryKey: keyQueryKeys.list(vars.format) });
      void qc.invalidateQueries({ queryKey: apiSurfacesQueryKey });
    },
  });

  $effect(() => {
    if (open) {
      format = defaultEngine;
      backend = undefined;
      answer = "default";
      name = "";
      expiresEnabled = false;
      expiresAt = "";
      issued = null;
      creating = false;
      issuedConnection = null;
      untrack(() => $createMut.reset());
    }
  });

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const date = expiresEnabled && expiresAt ? new Date(expiresAt) : null;
    if (expiresEnabled && (!date || Number.isNaN(date.getTime()) || date.getTime() <= Date.now())) {
      toast.error("Choose a future expiration date and time");
      return;
    }
    creating = true;
    // A provider-key pin ignores the engine, so none is sent; "API default" sends no source at all.
    const source = answer === "default" ? null : answer;
    const engine = pinsUpstream ? null : backend ?? null;
    $createMut.mutate({
      format, backend: engine, source, baseUrl,
      payload: {
        name: trimmed,
        ...(engine ? { backend_engine: engine } : {}),
        ...(source ? { source } : {}),
        expires_at: date?.toISOString() ?? null,
      },
    });
  }

  function handleDialogOpenChange(next: boolean) {
    if (!next && creating) { open = true; return; }
    open = next;
    if (!next) { issued = null; issuedConnection = null; $createMut.reset(); }
    onOpenChange?.(next);
  }
</script>

<Dialog.Root bind:open={() => open, handleDialogOpenChange}>
  <Dialog.Content size="wide" class="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:p-0">
    <Dialog.Header class="shrink-0 border-b p-5 pr-14 text-left sm:p-6 sm:pr-14">
      <Dialog.Title class="flex items-center gap-2">
        <KeyRound class="h-5 w-5 {issued ? 'text-success' : 'text-muted-foreground'}" />
        {issued ? "Key created" : "New API key"}
      </Dialog.Title>
      <Dialog.Description>
        {#if issued}Connection details for <span class="font-medium break-all">{issued.record.name}</span>. Copy the full key now; it is shown only once.
        {:else}Choose the API format your application uses and who answers this key’s requests: a subscription engine or a provider API key.{/if}
      </Dialog.Description>
    </Dialog.Header>

    <div class="min-h-0 overflow-y-auto p-5 sm:p-6">
      {#if issued && connection}
        <div class="grid min-w-0 gap-6 md:grid-cols-2">
          <section class="min-w-0 space-y-4" aria-label="Key details">
            <div class="rounded-md border bg-muted/40 p-4">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 class="text-body font-semibold">API key</h3>
                <CopyButton value={issued.key} label="Copy key" copiedLabel="Copied" size="sm" />
              </div>
              <code class="block break-all font-mono text-body" data-testid="issued-key">{issued.key}</code>
              <p class="mt-3 text-caption text-muted-foreground">Save this key before closing. If you lose it, create a replacement.</p>
            </div>
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-body">
              <dt class="text-muted-foreground">API format</dt><dd>{FORMAT_LABEL[connection.format]}</dd>
              <dt class="text-muted-foreground">Answered by</dt><dd>{answeredBy(connection.source, connectionSurface)}</dd>
              <dt class="text-muted-foreground">Engine</dt><dd class="font-medium">{connection.source === "upstream" ? "Not used" : connection.backend ? BACKEND_LABEL[connection.backend] : "Endpoint default"}</dd>
              <dt class="text-muted-foreground">Expires</dt><dd>{issued.record.expires_at ? formatDateTime(issued.record.expires_at) : "Never"}</dd>
              <dt class="text-muted-foreground">Availability</dt><dd><span role="status">{availability}</span></dd>
            </dl>
            <p class="text-caption text-muted-foreground">{connection.source === "upstream" ? `This key is always forwarded to ${providerName(connectionSurface)} with a stored provider key, whatever the API's source.` : connection.source === "emulated" ? "This key keeps its subscription and assigned engine when the endpoint default changes." : "This key keeps its assigned engine when the endpoint default changes, and follows the endpoint's source."}</p>
          </section>
          <section class="min-w-0 space-y-3" aria-label="Connection URLs">
            <h3 class="text-body font-semibold">Connect your application</h3>
            {#each urls as url (url.label)}
              <div class="min-w-0">
                <div class="mb-1 flex items-center justify-between gap-2">
                  <span class="text-caption font-medium">{url.label}{url.label === "Base URL" ? " · SDK setting" : ""}</span>
                  <CopyButton value={url.value} label="Copy" aria-label={`Copy ${url.label}`} copiedLabel="Copied" variant="ghost" size="sm" class="shrink-0" />
                </div>
                <code class="block break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-caption">{url.value}</code>
              </div>
            {/each}
          </section>
        </div>
        <details class="mt-5 min-w-0 rounded-md border p-4">
          <summary class="cursor-pointer text-body font-medium">Try a request with curl</summary>
          <p class="mt-3 text-caption text-muted-foreground">Replace MODEL_ID_FROM_MODELS_URL with an ID returned by the Models URL. The base URL above is for SDK configuration; this example uses a complete request URL.</p>
          <div class="my-2 flex justify-end"><CopyButton value={example} label="Copy curl example" size="sm" /></div>
          <pre class="whitespace-pre-wrap break-all font-mono text-caption">{example}</pre>
        </details>
      {:else}
        <form id="new-api-key" onsubmit={handleSubmit}>
          <fieldset disabled={creating} class="grid min-w-0 gap-6 md:grid-cols-2">
            <div class="min-w-0 space-y-5">
              <div class="grid gap-2">
                <Label for="key-format">API format</Label>
                <Select.Root type="single" value={format} onValueChange={(v) => { if (v) format = v as ApiKeyEngine; }} disabled={creating}>
                  <Select.Trigger id="key-format" class="w-full">{FORMAT_LABEL[format]}</Select.Trigger>
                  <Select.Content>
                    {#each ["openai", "claude", "grok", "kimi"] as value}
                      <Select.Item value={value} label={FORMAT_LABEL[value as ApiKeyEngine]} />
                    {/each}
                  </Select.Content>
                </Select.Root>
                <p class="text-caption text-muted-foreground">Matches your application’s SDK and request format.</p>
              </div>
              <div class="grid gap-2">
                <Label for="key-source">Answered by</Label>
                <SimpleSelect id="key-source" class="w-full" value={answer} options={answerOptions} disabled={!setupReady || creating} aria-describedby="key-source-hint" onValueChange={(v) => { answer = v === "emulated" || v === "upstream" ? v : "default"; }} />
                <p id="key-source-hint" class="text-caption text-muted-foreground">{answerHint}</p>
              </div>
              <div class="grid gap-2">
                <Label for="key-backend">Engine</Label>
                <Select.Root type="single" value={backend ?? ""} onValueChange={(v) => { backend = v ? v as ApiBackendEngine : undefined; }} disabled={!setupReady || creating || pinsUpstream}>
                  <Select.Trigger id="key-backend" class="w-full">{backend ? BACKEND_LABEL[backend] : "Choose an engine"}</Select.Trigger>
                  <Select.Content>
                    <!-- Only engines switched on fleet-wide are offered. -->
                    {#each engineRows.filter((row) => row.enabled) as row (row.engine)}
                      <Select.Item value={row.engine} label={row.label} />
                    {/each}
                  </Select.Content>
                </Select.Root>
                <p class="text-caption text-muted-foreground">{pinsUpstream ? `Not used: this key is forwarded to ${providerName(selected)}.` : "Uses this engine for this key only. Other keys keep their routing."}</p>
                {#if backend && !engineEnabled && setupReady && !pinsUpstream}<p role="alert" class="text-caption text-destructive">This engine is disabled. Choose another engine.</p>{/if}
              </div>
              <div class="grid gap-2">
                <Label for="key-name">Name</Label>
                <Input id="key-name" bind:value={name} placeholder="e.g. CI runner, laptop" required autocomplete="off" />
              </div>
            </div>
            <div class="min-w-0 space-y-5">
              <div class="rounded-md border bg-muted/40 p-4">
                <h3 class="text-body font-semibold">Connection preview</h3>
                <p class="mt-1 text-caption text-muted-foreground">Base URL for your SDK</p>
                {#if baseUrl}<code class="mt-3 block break-all font-mono text-caption">{baseUrl}</code>{/if}
                <p class="mt-3 text-body">Answered by: <span class="font-medium">{answeredBy(answer === "default" ? null : answer, selected)}</span></p>
                <p class="mt-1 text-body">Engine: <span class="font-medium">{pinsUpstream ? "Not used" : backend ? BACKEND_LABEL[backend] : "Choose an engine"}</span></p>
                <p class="mt-2 text-caption text-muted-foreground">{!setupReady ? "Loading connection settings…" : !pinsUpstream && !backend ? "Select an engine to finish setting up this connection." : available ? "API traffic is enabled." : $apiState.data?.disabled ? "All API traffic is disabled. You can create a key now and enable traffic under Configure." : selected?.disabled ? "This endpoint is disabled. You can create a key now and enable it under Configure." : effectiveSource === "upstream" ? `${upstreamProblem(selected)} Until then this key's requests fail.` : "The selected engine is disabled."}</p>
              </div>
              <div class="flex items-center justify-between gap-3 rounded-md border p-3">
                <div><Label for="key-expires-toggle">Expires</Label><p class="text-caption text-muted-foreground">Off = never expires.</p></div>
                <Switch id="key-expires-toggle" aria-label="Set an expiration date" checked={expiresEnabled} onCheckedChange={(v) => (expiresEnabled = v)} disabled={creating} />
              </div>
              {#if expiresEnabled}
                <div class="grid gap-2"><Label for="key-expires">Expiration date &amp; time</Label><Input id="key-expires" type="datetime-local" bind:value={expiresAt} required /></div>
              {/if}
              <p class="text-caption text-muted-foreground">The full key and copyable connection URLs appear after creation.</p>
            </div>
          </fieldset>
          {#if setupError}
            <div role="alert" class="mt-4 text-body text-destructive">Could not load connection settings. <Button type="button" variant="link" onclick={() => { void $surfaces.refetch(); void $engines.refetch(); void $apiState.refetch(); }}>Retry</Button></div>
          {/if}
          {#if $createMut.isError}<p role="alert" class="mt-4 text-body text-destructive">Failed to create key: {$createMut.error.message}</p>{/if}
        </form>
      {/if}
    </div>

    <Dialog.Footer class="shrink-0 border-t p-5 sm:p-6">
      {#if issued}<Button onclick={() => handleDialogOpenChange(false)}>Done</Button>
      {:else}
        <Button type="button" variant="outline" onclick={() => handleDialogOpenChange(false)} disabled={creating}>Cancel</Button>
        <Button type="submit" form="new-api-key" disabled={!canSubmit}>{creating ? "Creating…" : "Create key"}</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
