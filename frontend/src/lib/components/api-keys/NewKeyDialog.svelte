<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { keysApi, keyQueryKeys, engineLabel } from "$lib/api/keys";
  import type {
    AdminApiKeyCreated,
    ApiKeyEngine,
    CreateApiKeyPayload,
  } from "$lib/api/types";

  type Props = {
    open: boolean;
    defaultEngine?: ApiKeyEngine;
    onOpenChange?: (open: boolean) => void;
  };
  let {
    open = $bindable(false),
    defaultEngine = "openai",
    onOpenChange,
  }: Props = $props();

  const qc = useQueryClient();

  // Form state. `$state` initializer reads `defaultEngine` once at creation;
  // the `$effect` below re-syncs it whenever the dialog opens.
  // eslint-disable-next-line svelte/no-unused-svelte-ignore
  // svelte-ignore state_referenced_locally
  let engine = $state<ApiKeyEngine>(defaultEngine);
  let name = $state("");
  // Tracked as a string (not bind:value to a number $state) because clearing
  // a <input type="number"> to empty does not propagate to a bound numeric
  // Svelte state -- the state silently keeps its last valid value while the
  // input displays empty, which let an emptied field slip through as "60"
  // even with `required` set. A string mirrors the input's real content.
  let rateLimitRpm = $state("60");
  let expiresEnabled = $state(false);
  let expiresAt = $state(""); // datetime-local string

  // Reset form whenever the dialog opens.
  $effect(() => {
    if (open) {
      engine = defaultEngine;
      name = "";
      rateLimitRpm = "60";
      expiresEnabled = false;
      expiresAt = "";
    }
  });

  const createMut = createMutation<
    AdminApiKeyCreated,
    Error,
    { engine: ApiKeyEngine; payload: CreateApiKeyPayload }
  >({
    mutationFn: ({ engine, payload }) => keysApi.create(engine, payload),
    onSuccess: (data, vars) => {
      toast.success(`${engineLabel(vars.engine)} key issued`, {
        description: `"${data.record.name}" is now active.`,
      });
      void qc.invalidateQueries({ queryKey: keyQueryKeys.list(vars.engine) });

      // Hand the plaintext key off to /bootstrap via sessionStorage, never a
      // URL query param -- a plaintext key must never land in browser
      // history. The /bootstrap page reads and discards this exact contract.
      sessionStorage.setItem(
        "bootstrap:pending-key",
        JSON.stringify({
          engine: vars.engine,
          keyId: data.record.id,
          key: data.key,
          name: data.record.name,
          createdAt: Date.now(),
        }),
      );
      // Not close(): isPending is still true here (query-core awaits
      // options.onSuccess before dispatching the "success" state change), so
      // close()'s in-flight guard would silently no-op.
      open = false;
      onOpenChange?.(false);
      void goto(`${base}/bootstrap`);
    },
    onError: (err) => {
      toast.error("Failed to create key", { description: err.message });
    },
  });

  function toIso(local: string): string | null {
    if (!local) return null;
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name is required");
      return;
    }
    const rpm = Number(rateLimitRpm);
    if (!Number.isFinite(rpm) || rpm <= 0) {
      toast.error("Rate limit is required", {
        description: "Enter a positive number of requests per minute.",
      });
      return;
    }
    const payload: CreateApiKeyPayload = {
      name: trimmed,
      rate_limit_rpm: rpm,
      expires_at: expiresEnabled ? toIso(expiresAt) : null,
    };
    $createMut.mutate({ engine, payload });
  }

  function close() {
    if ($createMut.isPending) return;
    open = false;
    onOpenChange?.(false);
  }

  // Guard against Escape/overlay-click/close-button dismissal while a create
  // request is still in flight, so a stale onSuccess can't navigate away
  // out from under a second, unrelated submission.
  function handleDialogOpenChange(next: boolean) {
    if (!next && $createMut.isPending) {
      open = true;
      return;
    }
    open = next;
    onOpenChange?.(next);
  }
</script>

<Dialog.Root bind:open onOpenChange={handleDialogOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <form onsubmit={handleSubmit}>
      <Dialog.Header>
        <Dialog.Title>New API key</Dialog.Title>
        <Dialog.Description>
          Issue a programmatic key for OpenAI or Claude. You'll be taken to the
          bootstrap page to view and copy it once created.
        </Dialog.Description>
      </Dialog.Header>

      <div class="grid gap-4 py-4">
        <div class="grid gap-2">
          <Label for="key-engine">Engine</Label>
          <Select.Root
            type="single"
            value={engine}
            onValueChange={(v) => (engine = (v as ApiKeyEngine) ?? engine)}
          >
            <Select.Trigger id="key-engine">
              {engineLabel(engine)}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="openai" label="OpenAI (Codex)" />
              <Select.Item value="claude" label="Claude (Anthropic)" />
            </Select.Content>
          </Select.Root>
        </div>

        <div class="grid gap-2">
          <Label for="key-name">Name</Label>
          <Input
            id="key-name"
            bind:value={name}
            placeholder="e.g. CI runner, intern-laptop"
            required
            autocomplete="off"
            autofocus
          />
        </div>

        <div class="grid gap-2">
          <Label for="key-rpm">Rate limit (requests / minute)</Label>
          <Input
            id="key-rpm"
            type="number"
            min="1"
            max="100000"
            required
            bind:value={rateLimitRpm}
          />
        </div>

        <div class="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label for="key-expires-toggle" class="text-sm">Expires</Label>
            <p class="text-xs text-muted-foreground">
              Off = never expires.
            </p>
          </div>
          <Switch
            id="key-expires-toggle"
            aria-label="Set an expiration date"
            checked={expiresEnabled}
            onCheckedChange={(v) => (expiresEnabled = v)}
          />
        </div>

        {#if expiresEnabled}
          <div class="grid gap-2">
            <Label for="key-expires">Expiration date &amp; time</Label>
            <Input
              id="key-expires"
              type="datetime-local"
              bind:value={expiresAt}
            />
          </div>
        {/if}
      </div>

      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={close}
          disabled={$createMut.isPending}>Cancel</Button
        >
        <Button type="submit" disabled={$createMut.isPending}>
          {$createMut.isPending ? "Creating…" : "Create key"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
