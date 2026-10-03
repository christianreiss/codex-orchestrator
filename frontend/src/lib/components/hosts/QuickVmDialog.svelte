<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import Cpu from "@lucide/svelte/icons/cpu";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Layers from "@lucide/svelte/icons/layers";
  import Zap from "@lucide/svelte/icons/zap";
  import { toast } from "svelte-sonner";
  import { createQuickRegisterMutation } from "$lib/api/hosts";
  import { ReadonlyCodeBlock } from "$lib/components/ui/code-block";
  import { autoCopyText } from "$lib/utils/clipboard";
  import type { HostRegisterResponse } from "$lib/api/types";
  import { useFleetEngines, FLEET_DISABLED_TAG, fleetDisabledTitle } from "$lib/engines/fleet-engines";
  import { engineLabel } from "$lib/constants/engines";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  let { open = $bindable(false), onOpenChange }: Props = $props();

  const mutation = createQuickRegisterMutation();
  // A fleet-disabled engine cannot be provisioned (the server answers 409).
  // "All engines" provisions every engine still on rather than failing whole.
  const fleet = useFleetEngines();
  const allLabel = $derived($fleet.disabled.length === 0 ? "All engines" : "All enabled engines");
  const allHint = $derived(
    $fleet.enabled.length === 0
      ? "Every engine is off"
      : $fleet.enabled.map((engine) => engineLabel(engine)).join(" + "),
  );
  let result = $state<HostRegisterResponse | null>(null);
  let pending = $state<"codex" | "claude" | "grok" | "all" | null>(null);

  async function spin(engines: ("codex" | "claude" | "grok")[], key: "codex" | "claude" | "grok" | "all"): Promise<void> {
    pending = key;
    try {
      const data = await $mutation.mutateAsync({ engines });
      result = data;
      await autoCopyText(
        data.installer.command,
        "Installer command copied",
        "Quick VM provisioned",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to provision";
      toast.error(msg);
    } finally {
      pending = null;
    }
  }

  function handleOpenChange(value: boolean): void {
    if (!value) result = null;
    open = value;
    onOpenChange?.(value);
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Quick VM</Dialog.Title>
      <Dialog.Description>
        Register a throwaway host with a single click. The install command works for
        30 minutes; the host itself expires after 2 hours.
      </Dialog.Description>
    </Dialog.Header>

    {#if !result}
      <div class="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2">
        <button
          type="button"
          class="flex flex-col items-center justify-center gap-2 rounded-lg border border-input bg-background p-4 transition-colors hover:bg-accent disabled:opacity-50"
          disabled={pending !== null || !$fleet.isEnabled("codex")}
          title={$fleet.isEnabled("codex") ? undefined : fleetDisabledTitle("Codex")}
          onclick={() => spin(["codex"], "codex")}
        >
          <Cpu class="h-7 w-7 text-persona-codex" />
          <span class="text-sm font-semibold">Codex only</span>
          <span class="text-xs text-muted-foreground">{$fleet.isEnabled("codex") ? "Default engine" : FLEET_DISABLED_TAG}</span>
          {#if pending === "codex"}<span class="text-xs text-muted-foreground">Working…</span>{/if}
        </button>
        <button
          type="button"
          class="flex flex-col items-center justify-center gap-2 rounded-lg border border-input bg-background p-4 transition-colors hover:bg-accent disabled:opacity-50"
          disabled={pending !== null || !$fleet.isEnabled("claude")}
          title={$fleet.isEnabled("claude") ? undefined : fleetDisabledTitle("Claude")}
          onclick={() => spin(["claude"], "claude")}
        >
          <Sparkles class="h-7 w-7 text-persona-claude" />
          <span class="text-sm font-semibold">Claude only</span>
          <span class="text-xs text-muted-foreground">{$fleet.isEnabled("claude") ? "Claude Code" : FLEET_DISABLED_TAG}</span>
          {#if pending === "claude"}<span class="text-xs text-muted-foreground">Working…</span>{/if}
        </button>
        <button type="button"
          class="flex flex-col items-center justify-center gap-2 rounded-lg border border-input bg-background p-4 transition-colors hover:bg-accent disabled:opacity-50"
          disabled={pending !== null || !$fleet.isEnabled("grok")}
          title={$fleet.isEnabled("grok") ? undefined : fleetDisabledTitle("Grok")}
          onclick={() => spin(["grok"], "grok")}>
          <Zap class="h-7 w-7 text-persona-grok" />
          <span class="text-sm font-semibold">Grok only</span>
          <span class="text-xs text-muted-foreground">{$fleet.isEnabled("grok") ? "Grok Build · cgx" : FLEET_DISABLED_TAG}</span>
          {#if pending === "grok"}<span class="text-xs text-muted-foreground">Working…</span>{/if}
        </button>
        <button
          type="button"
          class="flex flex-col items-center justify-center gap-2 rounded-lg border border-input bg-background p-4 transition-colors hover:bg-accent disabled:opacity-50"
          disabled={pending !== null || $fleet.enabled.length === 0}
          onclick={() => spin([...$fleet.enabled], "all")}
        >
          <Layers class="h-7 w-7 text-violet-500" />
          <span class="text-sm font-semibold">{allLabel}</span>
          <span class="text-xs text-muted-foreground">{allHint}</span>
          {#if pending === "all"}<span class="text-xs text-muted-foreground">Working…</span>{/if}
        </button>
      </div>
    {:else}
      <div class="space-y-3 py-2">
        <div class="rounded-md border border-success/25 bg-success-muted px-3 py-2 text-sm">
          Provisioned <span class="font-mono">{result.host.fqdn ?? "(unknown)"}</span>. The command expires {new Date(result.installer.expires_at).toLocaleString()}.
        </div>
        <ReadonlyCodeBlock
          id="quickvm-installer"
          label="Installer command"
          value={result.installer.command}
          wrap
          rows={4}
        />
        <div class="flex justify-end gap-2">
          <Button variant="secondary" onclick={() => (result = null)}>Spin another</Button>
        </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
