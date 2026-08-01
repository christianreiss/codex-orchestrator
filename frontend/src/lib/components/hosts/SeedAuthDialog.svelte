<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import { RadioGroup, RadioGroupItem } from "$lib/components/ui/radio-group";
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
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { autoCopyText } from "$lib/utils/clipboard";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Pre-select an engine (e.g. when a host advertises only one). */
    defaultEngine?: AuthEngine;
  };

  let {
    open = $bindable(false),
    onOpenChange,
    defaultEngine = "codex",
  }: Props = $props();

  const qc = useQueryClient();
  const seedCmd = createSeedCommandMutation();
  const uploadAuth = createUploadAuthMutation(qc);

  type UploadMode = "apikey" | "chatgpt";

  let activeTab = $state<"upload" | "command">("upload");
  let engine: AuthEngine = $state("codex");
  // Codex only: an API key is a real value an operator can type; a ChatGPT
  // session is a pair of opaque JWTs that only ever come from
  // ~/.codex/auth.json, so that path keeps the paste/upload textarea.
  let uploadMode = $state<UploadMode>("apikey");
  let apiKey = $state("");
  let payload = $state("");
  let fileBusy = $state(false);
  let command = $state<string | null>(null);
  let commandExpiresAt = $state<string | null>(null);

  const isApiKeyMode = $derived(engine === "codex" && uploadMode === "apikey");

  // Reset state each time the dialog opens. We read `defaultEngine` inside the
  // effect so it picks up parent updates without capturing the initial value.
  $effect(() => {
    if (open) {
      activeTab = "upload";
      engine = defaultEngine;
      uploadMode = "apikey";
      apiKey = "";
      payload = "";
      command = null;
      commandExpiresAt = null;
    }
  });

  function handleOpenChange(value: boolean): void {
    open = value;
    onOpenChange?.(value);
  }

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

  async function submitUpload(): Promise<void> {
    let trimmed: string;
    if (isApiKeyMode) {
      const key = apiKey.trim();
      if (!key) {
        toast.error("Paste the OpenAI API key first.");
        return;
      }
      trimmed = JSON.stringify({ OPENAI_API_KEY: key });
    } else {
      trimmed = payload.trim();
      if (!trimmed) {
        toast.error("Paste auth payload or pick a file first.");
        return;
      }
    }
    try {
      await $uploadAuth.mutateAsync({ engine, payload: trimmed });
      toast.success(`Uploaded ${engine === "codex" ? "Codex" : "Claude"} auth`);
      handleOpenChange(false);
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

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Seed auth</Dialog.Title>
      <Dialog.Description>
        Upload canonical credentials or mint a short-lived one-time seed command
        the operator runs on the host.
      </Dialog.Description>
    </Dialog.Header>

    <Tabs.Root value={activeTab} onValueChange={(v) => (activeTab = v as "upload" | "command")}>
      <Tabs.List class="grid w-full grid-cols-2">
        <Tabs.Trigger value="upload">Upload</Tabs.Trigger>
        <Tabs.Trigger value="command">One-time command</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="upload" class="space-y-4 pt-3">
        <div class="space-y-2">
          <Label>Engine</Label>
          <RadioGroup
            value={engine}
            onValueChange={(v) => (engine = v as AuthEngine)}
            class="flex gap-4"
          >
            <label class="flex items-center gap-2 text-sm">
              <RadioGroupItem value="codex" id="seed-upload-codex" />
              Codex
            </label>
            <label class="flex items-center gap-2 text-sm">
              <RadioGroupItem value="claude" id="seed-upload-claude" />
              Claude
            </label>
          </RadioGroup>
        </div>

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

        <Dialog.Footer>
          <Button variant="ghost" onclick={() => handleOpenChange(false)} disabled={$uploadAuth.isPending}>
            Cancel
          </Button>
          <Button
            onclick={submitUpload}
            disabled={$uploadAuth.isPending || (isApiKeyMode ? !apiKey.trim() : !payload.trim())}
          >
            {$uploadAuth.isPending ? "Uploading…" : "Upload"}
          </Button>
        </Dialog.Footer>
      </Tabs.Content>

      <Tabs.Content value="command" class="space-y-4 pt-3">
        <div class="space-y-2">
          <Label>Engine</Label>
          <RadioGroup
            value={engine}
            onValueChange={(v) => (engine = v as AuthEngine)}
            class="flex gap-4"
          >
            <label class="flex items-center gap-2 text-sm">
              <RadioGroupItem value="codex" id="seed-cmd-codex" />
              Codex
            </label>
            <label class="flex items-center gap-2 text-sm">
              <RadioGroupItem value="claude" id="seed-cmd-claude" />
              Claude
            </label>
          </RadioGroup>
        </div>

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

        <Dialog.Footer>
          <Button variant="ghost" onclick={() => handleOpenChange(false)} disabled={$seedCmd.isPending}>
            Close
          </Button>
          {#if command}
            <CopyButton value={command} label="Copy command" toastMessage="Command copied" />
            <Button onclick={generateCommand} disabled={$seedCmd.isPending}>
              {$seedCmd.isPending ? "Generating…" : "Regenerate"}
            </Button>
          {:else}
            <Button onclick={generateCommand} disabled={$seedCmd.isPending}>
              {$seedCmd.isPending ? "Generating…" : "Generate"}
            </Button>
          {/if}
        </Dialog.Footer>
      </Tabs.Content>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>
