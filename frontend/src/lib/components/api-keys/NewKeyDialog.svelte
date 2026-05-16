<script lang="ts">
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import AlertTriangle from "@lucide/svelte/icons/triangle-alert";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { keysApi, keyQueryKeys, engineLabel } from "$lib/api/keys";
  import type {
    AdminApiKeyCreated,
    ApiKeyEngine,
    CreateApiKeyPayload,
  } from "$lib/api/types";

  type Props = {
    open: boolean;
    defaultEngine?: ApiKeyEngine;
  };
  let { open = $bindable(false), defaultEngine = "openai" }: Props = $props();

  const qc = useQueryClient();

  // Form state. `$state` initializer reads `defaultEngine` once at creation;
  // the `$effect` below re-syncs it whenever the dialog opens.
  // eslint-disable-next-line svelte/no-unused-svelte-ignore
  // svelte-ignore state_referenced_locally
  let engine = $state<ApiKeyEngine>(defaultEngine);
  let name = $state("");
  let rateLimitRpm = $state(60);
  let expiresEnabled = $state(false);
  let expiresAt = $state(""); // datetime-local string

  // Reveal state
  let issued = $state<AdminApiKeyCreated | null>(null);
  let copied = $state(false);

  // Reset form whenever the dialog opens.
  $effect(() => {
    if (open) {
      engine = defaultEngine;
      name = "";
      rateLimitRpm = 60;
      expiresEnabled = false;
      expiresAt = "";
      issued = null;
      copied = false;
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
    const payload: CreateApiKeyPayload = {
      name: trimmed,
      rate_limit_rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : 60,
      expires_at: expiresEnabled ? toIso(expiresAt) : null,
    };
    $createMut.mutate({ engine, payload });
  }

  async function copyKey() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.key);
      copied = true;
      toast.success("Key copied to clipboard");
      setTimeout(() => (copied = false), 2000);
    } catch (err) {
      toast.error("Copy failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function close() {
    open = false;
  }
</script>

<Dialog.Root bind:open>
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
        <Button variant="outline" size="icon" onclick={copyKey} aria-label="Copy key">
          {#if copied}
            <Check class="h-4 w-4 text-emerald-600" />
          {:else}
            <Copy class="h-4 w-4" />
          {/if}
        </Button>
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
              bind:value={rateLimitRpm}
            />
          </div>

          <div class="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label class="text-sm">Expires</Label>
              <p class="text-xs text-muted-foreground">
                Off = never expires.
              </p>
            </div>
            <Switch
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
          <Button type="button" variant="outline" onclick={close}>Cancel</Button>
          <Button type="submit" disabled={$createMut.isPending}>
            {$createMut.isPending ? "Creating…" : "Create key"}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
