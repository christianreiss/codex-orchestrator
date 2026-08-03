<script lang="ts">
  /**
   * Canonical provider-auth seeding, without any container chrome.
   *
   * Extracted from SeedAuthDialog so the wizard and the hosts-page dialog share
   * one implementation — this is the only canonical-auth UI in the product, and
   * two copies would drift immediately.
   *
   * Two things it gets right that the original did not:
   *
   *  - **HTTP 200 is not success.** `storeCandidate` answers 200 with
   *    `verification_state: 'pending' | 'failed'`, and the setup checklist
   *    counts only `verified`. A blanket success toast left operators staring at
   *    a red checklist with no explanation, so the outcome is reported as it
   *    actually came back.
   *  - **A dead auth runner is diagnosed, not retried.** Every store is gated
   *    behind a live runner probe; without one, each attempt returns 503. Saying
   *    so up front beats three identical failures.
   */
  import { untrack } from "svelte";
  import * as Tabs from "$lib/components/ui/tabs";
  import { RadioGroup, RadioGroupItem } from "$lib/components/ui/radio-group";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Textarea } from "$lib/components/ui/textarea";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import Upload from "@lucide/svelte/icons/upload";
  import {
    createSeedCommandMutation,
    createUploadAuthMutation,
    type AuthEngine,
  } from "$lib/api/auth";
  import { invalidateSetup } from "$lib/api/setup";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { autoCopyText } from "$lib/utils/clipboard";

  type Props = {
    /** Engines offered. One entry hides the engine picker entirely. */
    allowedEngines?: AuthEngine[];
    defaultEngine?: AuthEngine;
    /** Set false when the readiness check says the auth runner is down. */
    runnerHealthy?: boolean;
    /** Rendered under the tabs; the dialog passes its footer buttons here. */
    footer?: import("svelte").Snippet<[{ busy: boolean; submit: () => Promise<void> }]>;
    onStored?: (outcome: "verified" | "pending" | "failed") => void;
  };

  let {
    allowedEngines = ["codex", "claude"],
    defaultEngine = "codex",
    runnerHealthy = true,
    footer,
    onStored,
  }: Props = $props();

  const qc = useQueryClient();
  const seedCmd = createSeedCommandMutation();
  const uploadAuth = createUploadAuthMutation(qc);

  type UploadMode = "apikey" | "chatgpt";

  let activeTab = $state<"upload" | "command">("upload");
  // Seed once and let the operator drive it from there; `reset()` re-applies
  // the prop when the container wants a fresh panel. `untrack` says that is
  // deliberate rather than a missed reactive read.
  let engine: AuthEngine = $state(
    untrack(() => (allowedEngines.includes(defaultEngine) ? defaultEngine : allowedEngines[0]!)),
  );
  // Codex only: an API key is a real value an operator can type; a ChatGPT
  // session is a pair of opaque JWTs that only ever come from
  // ~/.codex/auth.json, so that path keeps the paste/upload textarea.
  let uploadMode = $state<UploadMode>("apikey");
  let apiKey = $state("");
  let payload = $state("");
  let fileBusy = $state(false);
  let command = $state<string | null>(null);
  let commandExpiresAt = $state<string | null>(null);
  let result = $state<{ engine: AuthEngine; state: string } | null>(null);

  const isApiKeyMode = $derived(engine === "codex" && uploadMode === "apikey");
  const busy = $derived($uploadAuth.isPending);

  // No `reset()`: containers that need a clean panel remount it instead
  // (`{#key open}` in SeedAuthDialog). An imperative reset would have to be
  // called at exactly the right moment relative to `bind:this`, and getting
  // that wrong leaves a previous operator's pasted credentials in the textarea.

  async function handleFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    fileBusy = true;
    try {
      const reader = new FileReader();
      const text = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsText(file);
      });
      payload = text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read file";
      toast.error(msg);
    } finally {
      fileBusy = false;
      // allow same file to be selected again
      input.value = "";
    }
  }

  export async function submitUpload(): Promise<void> {
    let trimmed: string;
    if (isApiKeyMode) {
      const key = apiKey.trim();
      if (!key) {
        toast.error("Paste the OpenAI API key first.");
        return;
      }
      // The server rejects a bare string for codex but wraps one for claude, so
      // codex gets its envelope here.
      trimmed = JSON.stringify({ OPENAI_API_KEY: key });
    } else {
      trimmed = payload.trim();
      if (!trimmed) {
        toast.error("Paste auth payload or pick a file first.");
        return;
      }
    }
    try {
      const res = await $uploadAuth.mutateAsync({ engine, payload: trimmed });
      const state = res.verification_state ?? "unknown";
      result = { engine, state };
      invalidateSetup(qc);

      const name = engine === "codex" ? "Codex" : "Claude";
      if (state === "verified") {
        toast.success(`${name} credentials verified`);
        onStored?.("verified");
      } else if (state === "failed") {
        toast.error(`${name} credentials stored but failed verification`);
        onStored?.("failed");
      } else {
        toast.warning(`${name} credentials stored, verification pending`);
        onStored?.("pending");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast.error(msg);
    }
  }

  async function generateCommand(): Promise<void> {
    try {
      const res = await $seedCmd.mutateAsync({ engine });
      command = res.command ?? null;
      commandExpiresAt = res.expires_at ?? null;
      if (!command) {
        // A backend without a database cannot mint a token and only
        // acknowledges the request — say so rather than showing nothing.
        toast.success("Seed request queued");
      } else {
        await autoCopyText(command, "Seed command copied", "Seed command ready");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to mint command";
      toast.error(msg);
    }
  }
</script>

{#snippet enginePicker(idPrefix: string)}
  {#if allowedEngines.length > 1}
    <div class="space-y-2">
      <Label>Engine</Label>
      <RadioGroup
        value={engine}
        onValueChange={(v) => (engine = v as AuthEngine)}
        class="flex gap-4"
      >
        {#each allowedEngines as option (option)}
          <label class="flex items-center gap-2 text-sm">
            <RadioGroupItem value={option} id="{idPrefix}-{option}" />
            {option === "codex" ? "Codex" : "Claude"}
          </label>
        {/each}
      </RadioGroup>
    </div>
  {/if}
{/snippet}

{#if !runnerHealthy}
  <Alert variant="destructive" class="mb-4">
    <AlertTitle>The auth runner is not reachable</AlertTitle>
    <AlertDescription>
      Every credential is verified against a live runner probe before it is stored, so
      uploads will fail with a 503 until it is healthy. Check
      <code class="text-xs">docker compose logs auth-runner</code>.
    </AlertDescription>
  </Alert>
{/if}

{#if result}
  <Alert
    variant={result.state === "failed" ? "destructive" : "default"}
    class="mb-4"
  >
    <AlertTitle>
      {result.engine === "codex" ? "Codex" : "Claude"} credentials
      {result.state === "verified"
        ? "verified"
        : result.state === "failed"
          ? "failed verification"
          : "pending verification"}
    </AlertTitle>
    <AlertDescription>
      {#if result.state === "verified"}
        Stored and confirmed against the live provider. This engine is ready.
      {:else if result.state === "failed"}
        The runner rejected these credentials. They are stored but will not be served —
        check the value and upload again.
      {:else}
        Stored, but the runner has not confirmed them yet. The setup checklist counts only
        verified credentials, so this step stays open until it does.
      {/if}
    </AlertDescription>
  </Alert>
{/if}

<Tabs.Root value={activeTab} onValueChange={(v) => (activeTab = v as "upload" | "command")}>
  <Tabs.List class="grid w-full grid-cols-2">
    <Tabs.Trigger value="upload">Upload</Tabs.Trigger>
    <Tabs.Trigger value="command">One-time command</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="upload" class="space-y-4 pt-3">
    {@render enginePicker("seed-upload")}

    {#if engine === "codex"}
      <div class="space-y-2">
        <Label>Credential type</Label>
        <RadioGroup
          value={uploadMode}
          onValueChange={(v) => (uploadMode = v as UploadMode)}
          class="flex gap-4"
        >
          <label class="flex items-center gap-2 text-sm">
            <RadioGroupItem value="apikey" id="seed-upload-mode-apikey" />
            API key
          </label>
          <label class="flex items-center gap-2 text-sm">
            <RadioGroupItem value="chatgpt" id="seed-upload-mode-chatgpt" />
            ChatGPT session
          </label>
        </RadioGroup>
      </div>
    {/if}

    {#if isApiKeyMode}
      <div class="space-y-1.5">
        <Label for="seed-upload-apikey">OpenAI API key</Label>
        <Input
          id="seed-upload-apikey"
          type="password"
          bind:value={apiKey}
          autocomplete="new-password"
          placeholder="sk-…"
        />
        <p class="text-[11px] text-muted-foreground">
          Stored as the host's canonical credential, the same key you'd put in
          <code class="font-mono">OPENAI_API_KEY</code>.
        </p>
      </div>
    {:else}
      <div class="space-y-1.5">
        <Label for="seed-upload-payload">
          {engine === "codex" ? "ChatGPT session auth JSON" : "Canonical Claude auth JSON or API key"}
        </Label>
        <Textarea
          id="seed-upload-payload"
          class="h-40 font-mono text-xs"
          placeholder={engine === "codex"
            ? '{ "tokens": { "access_token": "…", "refresh_token": "…" }, … }'
            : '{ "claudeAiOauth": { "accessToken": "sk-ant-oat…" } }'}
          bind:value={payload}
        />
        {#if engine === "codex"}
          <p class="text-[11px] text-muted-foreground">
            Paste the contents of <code class="font-mono">~/.codex/auth.json</code> from a
            ChatGPT-authenticated session. These tokens are machine-generated, never hand-typed.
          </p>
        {:else}
          <p class="text-[11px] text-muted-foreground">
            Paste the native Claude credentials JSON. A genuine Anthropic API key is also accepted.
          </p>
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <Label
          for="seed-upload-file"
          class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent"
        >
          <Upload class="h-4 w-4" />
          {fileBusy ? "Reading…" : "Pick file"}
        </Label>
        <input
          id="seed-upload-file"
          type="file"
          accept=".json,.txt,text/plain,application/json"
          class="hidden"
          onchange={handleFile}
        />
        <p class="text-[11px] text-muted-foreground">
          Reads the file into the textarea — does not auto-submit.
        </p>
      </div>
    {/if}

    {#if footer}
      {@render footer({ busy, submit: submitUpload })}
    {:else}
      <Button
        onclick={submitUpload}
        disabled={busy || (isApiKeyMode ? !apiKey.trim() : !payload.trim())}
      >
        {busy ? "Uploading…" : "Upload credentials"}
      </Button>
    {/if}
  </Tabs.Content>

  <Tabs.Content value="command" class="space-y-4 pt-3">
    {@render enginePicker("seed-cmd")}

    {#if command}
      <div class="space-y-1.5">
        <Label for="seed-cmd-output">One-time command</Label>
        <textarea
          id="seed-cmd-output"
          readonly
          class="h-32 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs"
          value={command}
        ></textarea>
        {#if commandExpiresAt}
          <p class="text-[11px] text-muted-foreground">
            Expires {new Date(commandExpiresAt).toLocaleString()}.
          </p>
        {/if}
      </div>
    {:else}
      <p class="text-xs text-muted-foreground">
        Click <em>Generate</em> to mint a short-lived bash one-liner. The operator
        runs it on the host once; the curl will POST credentials back through
        the runner.
      </p>
    {/if}

    <div class="flex items-center gap-2">
      {#if command}
        <CopyButton value={command} label="Copy command" toastMessage="Command copied" />
      {/if}
      <Button onclick={generateCommand} disabled={$seedCmd.isPending}>
        {$seedCmd.isPending ? "Generating…" : command ? "Regenerate" : "Generate"}
      </Button>
    </div>
  </Tabs.Content>
</Tabs.Root>
