<script lang="ts">
  /**
   * Add or edit one provider API key. The key value is write-only: it is never
   * prefilled, never echoed and dropped from memory after a confirmed save.
   *
   * Saving does not verify on the server, so the dialog chains a verification
   * after a save that stored a new key or base URL and shows its verdict here.
   * A saved key is never re-submitted: a retry would only hit
   * `provider_key_duplicate`, so after a save the one retry is "Verify again".
   */
  import { untrack } from "svelte";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { FormField } from "$lib/components/ui/form-field";
  import { SimpleSelect } from "$lib/components/ui/select";
  import DraftGuard from "$lib/components/page/DraftGuard.svelte";
  import { ApiError } from "$lib/api/client";
  import { providerKeysApi, providerKeysQueryKey } from "$lib/api/provider-keys";
  import { apiSurfacesQueryKey } from "$lib/api/settings";
  import type { ProviderId, ProviderKey, ProviderKeyProvider, ProviderKeysValue, UpdateProviderKeyPayload } from "$lib/api/types";
  import { engineLabel } from "$lib/constants/engines";
  import { errorField, keyErrorText, validateKeyValue, VERIFICATION, type KeyError, type KeyField } from "./provider-key-model";

  type Props = {
    open: boolean;
    /** Providers a new key may be added for (switched-on engines only). */
    providers: readonly ProviderKeyProvider[];
    /** The key to edit; null adds a new one. */
    editing?: ProviderKey | null;
    defaultProvider?: ProviderId | null;
  };
  let { open = $bindable(false), providers, editing = null, defaultProvider = null }: Props = $props();

  const qc = useQueryClient();
  let provider = $state<string>("");
  let label = $state("");
  let keyValue = $state("");
  let baseUrl = $state("");
  let initial = $state("");
  let phase = $state<"form" | "saving" | "verifying" | "done">("form");
  let errors = $state<Partial<Record<KeyField, string>>>({});
  let formError = $state<string | null>(null);
  /** The confirmed record after a save, and the verdict of its last check. */
  let saved = $state<ProviderKey | null>(null);
  let verifyFailure = $state<string | null>(null);

  const current = $derived(providers.find((p) => p.provider === (editing?.provider ?? provider)) ?? null);
  const providerName = $derived(current?.label ?? "provider");
  const engineName = $derived(current ? engineLabel(current.engine) : "Its engine");
  const options = $derived(providers.map((p) => ({ value: p.provider, label: p.label })));
  const snapshot = () => JSON.stringify([provider, label, keyValue !== "", baseUrl]);
  const dirty = $derived(open && phase === "form" && snapshot() !== initial);
  const busy = $derived(phase === "saving" || phase === "verifying");

  // Reset only when the dialog opens: a background refresh of the list must not overwrite a draft (INT-3).
  $effect(() => {
    if (!open) return;
    untrack(() => {
      provider = editing?.provider ?? defaultProvider ?? providers[0]?.provider ?? "";
      label = editing?.label ?? "";
      keyValue = "";
      baseUrl = editing?.base_url ?? "";
      errors = {};
      formError = null;
      saved = null;
      verifyFailure = null;
      phase = "form";
      initial = snapshot();
    });
  });

  function setOpen(next: boolean): void {
    if (!next && (busy || (dirty && !window.confirm(editing ? `Discard changes to ${editing.label}?` : "Discard this provider key?")))) {
      open = true;
      return;
    }
    open = next;
    if (!next) keyValue = "";
  }

  function remember(record: ProviderKey): void {
    saved = record;
    qc.setQueryData<ProviderKeysValue>(providerKeysQueryKey, (data) => {
      if (!data) return data;
      const exists = data.keys.some((k) => k.id === record.id);
      return { ...data, keys: exists ? data.keys.map((k) => (k.id === record.id ? record : k)) : [...data.keys, record] };
    });
  }

  function refresh(): void {
    void qc.invalidateQueries({ queryKey: providerKeysQueryKey });
    void qc.invalidateQueries({ queryKey: apiSurfacesQueryKey });
  }

  function fail(err: unknown): void {
    const error: KeyError & object = err instanceof ApiError ? err : { message: err instanceof Error ? err.message : undefined };
    const text = keyErrorText(error, providerName, engineName);
    const field = errorField(error);
    if (field) errors = { [field]: text };
    else formError = text;
    if (error.code === "provider_key_not_found") refresh();
  }

  async function verify(record: ProviderKey): Promise<void> {
    phase = "verifying";
    verifyFailure = null;
    try {
      remember(await providerKeysApi.verify(record.id));
    } catch (err) {
      verifyFailure = keyErrorText(err instanceof ApiError ? err : { message: err instanceof Error ? err.message : undefined }, providerName, engineName);
    } finally {
      phase = "done";
      refresh();
    }
  }

  function validate(): boolean {
    const next: Partial<Record<KeyField, string>> = {};
    if (!label.trim()) next.label = "Name the key, for example the account or project it belongs to.";
    else if (label.trim().length > 255) next.label = "At most 255 characters.";
    if (!editing || keyValue !== "") {
      const keyError = validateKeyValue(keyValue);
      if (keyError) next.key = keyError;
    }
    const url = baseUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) next.base_url = "Enter a full URL that starts with https://.";
    errors = next;
    return Object.keys(next).length === 0;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    formError = null;
    if (!validate()) return;
    if (!editing && !current) {
      errors = {};
      formError = "Choose a provider.";
      return;
    }
    phase = "saving";
    try {
      let record: ProviderKey;
      let checkAfterSave = true;
      if (editing) {
        // Only what changed: an empty PATCH is a 400, and an empty key field keeps the stored key.
        const patch: UpdateProviderKeyPayload = {};
        if (label.trim() !== editing.label) patch.label = label.trim();
        if (keyValue !== "") patch.key = keyValue.trim();
        if (baseUrl.trim() !== (editing.base_url ?? "")) patch.base_url = baseUrl.trim();
        checkAfterSave = patch.key !== undefined || patch.base_url !== undefined;
        record = await providerKeysApi.update(editing.id, patch);
      } else {
        record = await providerKeysApi.create({
          provider: current!.provider,
          label: label.trim(),
          key: keyValue.trim(),
          ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
        });
      }
      keyValue = "";
      initial = snapshot();
      remember(record);
      if (!checkAfterSave) {
        toast.success(`Saved ${record.label}`);
        refresh();
        open = false;
        return;
      }
      await verify(record);
    } catch (err) {
      phase = "form";
      fail(err);
    }
  }

  const verdict = $derived(saved ? VERIFICATION[saved.verification_state] : null);
  const verdictText = $derived.by(() => {
    if (!saved) return "";
    if (verifyFailure) return `Saved, but it could not be checked: ${verifyFailure}`;
    switch (saved.verification_state) {
      case "valid":
        return saved.verification_reason
          ? `Saved and verified: ${providerName} accepted the key with limited rights (${saved.verification_reason}). Endpoints it may not call answer with the provider's error.`
          : `Saved and verified: ${providerName} accepted the key.`;
      case "invalid":
        return `Saved, but ${providerName} rejected the key${saved.verification_reason ? ` (${saved.verification_reason})` : ""}. It is skipped in failover until you replace it.`;
      case "error":
        return `Saved, but the check failed${saved.verification_reason ? ` (${saved.verification_reason})` : ""}. The key stays in the failover order; verify again later.`;
      default:
        return "Saved. The key has not been checked yet.";
    }
  });
</script>

<DraftGuard {dirty} />
<Dialog.Root bind:open={() => open, setOpen}>
  <Dialog.Content size="lg">
    <form onsubmit={submit} class="flex min-w-0 flex-col gap-4" novalidate>
      <Dialog.Header>
        <Dialog.Title>{editing ? `Edit ${editing.label}` : "Add provider key"}</Dialog.Title>
        <Dialog.Description>
          {#if current?.base_path}
            Answers <code class="font-mono">{current.base_path}</code> while its source is API key, billed to your {providerName} account. The key stays on this server and is never shown again.
          {:else}
            The key stays on this server and is never shown again.
          {/if}
        </Dialog.Description>
      </Dialog.Header>

      {#if phase === "done" || phase === "verifying"}
        <div class="space-y-3" aria-live="polite">
          {#if phase === "verifying"}
            <p role="status" class="text-body-sm text-muted-foreground">Saved. Checking the key with {providerName}…</p>
          {:else if saved && verdict}
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-body font-medium">{saved.label}</span>
              <code class="font-mono text-caption text-muted-foreground">{saved.key_hint}</code>
              {#if !verifyFailure}<span class="text-body-sm">{verdict.label}</span>{/if}
            </div>
            <p role="status" class={saved.verification_state === "invalid" || verifyFailure ? "text-body-sm text-destructive" : saved.verification_state === "error" ? "text-body-sm text-warning" : "text-body-sm text-muted-foreground"}>{verdictText}</p>
          {/if}
        </div>
      {:else}
        <fieldset disabled={busy} class="grid min-w-0 gap-4">
          {#if editing}
            <div class="space-y-1.5">
              <p class="text-body-sm font-semibold">Provider</p>
              <p class="text-body">{providerName} <span class="text-muted-foreground">· the provider of a stored key cannot change</span></p>
            </div>
          {:else}
            <div class="space-y-1.5">
              <Label for="provider-key-provider">Provider</Label>
              <SimpleSelect id="provider-key-provider" class="w-full" bind:value={provider} {options} placeholder="Choose a provider" aria-describedby="provider-key-provider-hint" />
              <p id="provider-key-provider-hint" class="text-body-sm text-muted-foreground">
                {current?.base_path ? `Its key answers ${current.base_path}.` : "Only providers whose engine is switched on are offered."}
              </p>
            </div>
          {/if}

          <FormField id="provider-key-label" label="Name" required error={errors.label} hint="Shown in this list and in Activity, for example the account or project.">
            {#snippet children(f)}
              <Input id="provider-key-label" bind:value={label} maxlength={255} autocomplete="off" aria-describedby={f.describedBy} aria-invalid={f.invalid} />
            {/snippet}
          </FormField>

          <FormField
            id="provider-key-value"
            label={editing ? "New API key" : "API key"}
            required={!editing}
            error={errors.key}
            hint={editing ? `Leave empty to keep the stored key (${editing.key_hint}). A new key is checked again after saving.` : `From your ${providerName} account. Stored encrypted; only its first characters and last four are shown afterwards.`}
          >
            {#snippet children(f)}
              <Input
                id="provider-key-value"
                type="password"
                autocomplete="new-password"
                spellcheck={false}
                autocapitalize="off"
                class="font-mono"
                bind:value={keyValue}
                aria-describedby={f.describedBy}
                aria-invalid={f.invalid}
              />
            {/snippet}
          </FormField>

          <FormField
            id="provider-key-base-url"
            label="Base URL (optional)"
            error={errors.base_url}
            hint="Leave empty for the provider's own endpoint. Set it for a regional or compatible endpoint; https only, and private addresses are refused."
          >
            {#snippet children(f)}
              <Input
                id="provider-key-base-url"
                type="url"
                inputmode="url"
                autocomplete="off"
                spellcheck={false}
                class="font-mono"
                placeholder={current?.default_base_url ?? "https://"}
                bind:value={baseUrl}
                aria-describedby={f.describedBy}
                aria-invalid={f.invalid}
              />
            {/snippet}
          </FormField>
        </fieldset>
        {#if formError}<p role="alert" class="text-body-sm text-destructive">{formError}</p>{/if}
      {/if}

      <Dialog.Footer>
        {#if phase === "done" || phase === "verifying"}
          {#if saved && (verifyFailure || saved.verification_state !== "valid")}
            <Button type="button" variant="outline" disabled={busy} onclick={() => saved && void verify(saved)}>{busy ? "Checking…" : "Verify again"}</Button>
          {/if}
          <Button type="button" disabled={busy} onclick={() => setOpen(false)}>Done</Button>
        {:else}
          <Button type="button" variant="outline" disabled={busy} onclick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || (!!editing && !dirty)}>{phase === "saving" ? "Saving…" : editing ? "Save key" : "Add key"}</Button>
        {/if}
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
