<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { CopyButton } from "$lib/components/ui/copy-button";
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

  // Reveal state
  let issued = $state<AdminApiKeyCreated | null>(null);

  // Reset form whenever the dialog opens.
  $effect(() => {
    if (open) {
      engine = defaultEngine;
      name = "";
      rateLimitRpm = "60";
      expiresEnabled = false;
      expiresAt = "";
      issued = null;
    }
  });

  const createMut = createMutation<
    AdminApiKeyCreated,
    Error,
    { engine: ApiKeyEngine; payload: CreateApiKeyPayload }
  >({
    mutationFn: ({ engine, payload }) => keysApi.create(engine, payload),
    onSuccess: (data, vars) => {
      issued = data;
      toast.success(`${engineLabel(vars.engine)} key issued`, {
        description: `"${data.record.name}" is now active.`,
      });
      void qc.invalidateQueries({ queryKey: keyQueryKeys.list(vars.engine) });
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
  // request is still in flight, so a stale onSuccess can't hijack the
  // one-time key reveal screen out from under a second, unrelated submission.
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
    {#if issued}
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2">
          <KeyRound class="h-5 w-5 text-emerald-600" />
          Key created
        </Dialog.Title>
        <Dialog.Description>
          Copy <span class="font-medium">{issued.record.name}</span> now — this is the
          only time it will be shown.
        </Dialog.Description>
      </Dialog.Header>

      <Alert variant="warning">
        <AlertTriangle class="h-4 w-4" />
        <AlertTitle>Save this key somewhere safe</AlertTitle>
        <AlertDescription>
          We don't store the plaintext key. If you lose it, you'll need to issue
          a new one.
        </AlertDescription>
      </Alert>

      <div class="flex items-center gap-2">
        <code
          class="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs"
          >{issued.key}</code
        >
        <CopyButton
          value={issued.key}
          variant="outline"
          size="icon"
          aria-label="Copy key"
          toastMessage="Key copied to clipboard"
        />
      </div>

      <Dialog.Footer>
        <Button onclick={close}>Done</Button>
      </Dialog.Footer>
    {:else}
      <form onsubmit={handleSubmit}>
        <Dialog.Header>
          <Dialog.Title>New API key</Dialog.Title>
          <Dialog.Description>
            Issue a programmatic key for OpenAI or Claude. The full key is shown
            once after creation.
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
    {/if}
  </Dialog.Content>
</Dialog.Root>
