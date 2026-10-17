<script lang="ts">
  /**
   * "Get install command" (mint installer): the header's one primary action and the
   * Fix for most problems. Exposes `mint()` so the Needs-attention list can trigger it.
   */
  import Download from "@lucide/svelte/icons/download";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { createMintInstallerMutation } from "$lib/api/hosts";
  import { autoCopyText } from "$lib/utils/clipboard";
  import type { InstallerInfo } from "$lib/api/types";

  type Props = { id: string; fqdn: string; curlInsecure?: boolean };
  let { id, fqdn, curlInsecure }: Props = $props();

  const mutation = createMintInstallerMutation(useQueryClient());
  let open = $state(false);
  let result = $state<InstallerInfo | null>(null);

  export async function mint(): Promise<void> {
    try {
      const response = await $mutation.mutateAsync({ id, curl_insecure: curlInsecure });
      result = response.installer;
      open = true;
      await autoCopyText(response.installer.command, "Install command copied", "Install command ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the install command");
    }
  }
</script>

<Button onclick={mint} disabled={$mutation.isPending} title="Mint installer: a one-time command that installs or updates the host agent">
  <Download class="h-4 w-4" /> {$mutation.isPending ? "Working…" : "Get install command"}
</Button>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Install command</Dialog.Title>
      <Dialog.Description>
        {result?.label ?? "Installer"} for {fqdn}. Run it on the host. It works once and expires {result ? new Date(result.expires_at).toLocaleString() : "soon"}.
      </Dialog.Description>
    </Dialog.Header>
    <div class="space-y-3">
      <div class="space-y-1.5">
        <Label for="host-installer-url">Installer URL</Label>
        <Input id="host-installer-url" readonly value={result?.url ?? ""} class="font-mono" />
      </div>
      <div class="space-y-1.5">
        <Label for="host-installer-command">Command</Label>
        <textarea id="host-installer-command" readonly class="h-36 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-body-sm" value={result?.command ?? ""}></textarea>
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="secondary" onclick={mint} disabled={$mutation.isPending}>
        <RefreshCw class="h-4 w-4" /> {$mutation.isPending ? "Working…" : "Create a new one"}
      </Button>
      <CopyButton value={result?.url ?? ""} label="Copy URL" toastMessage="Installer URL copied" disabled={!result?.url} />
      <CopyButton value={result?.command ?? ""} label="Copy command" toastMessage="Install command copied" disabled={!result?.command} />
      <Button variant="ghost" onclick={() => (open = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
