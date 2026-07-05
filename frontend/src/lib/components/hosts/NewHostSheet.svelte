<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { onMount, tick } from "svelte";
  import { z } from "zod";
  import { toast } from "svelte-sonner";
  import { createRegisterHostMutation, createDeleteHostMutation } from "$lib/api/hosts";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { autoCopyText } from "$lib/utils/clipboard";
  import type { HostRegisterResponse } from "$lib/api/types";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  let { open = $bindable(false), onOpenChange }: Props = $props();

  const qc = useQueryClient();
  const register = createRegisterHostMutation();
  const deleteMut = createDeleteHostMutation(qc);

  const schema = z.object({
    fqdn: z.string().trim().min(1, "Hostname is required"),
    vibe: z.enum(["secure", "temporary", "insecure-curl", "vip"]).array(),
    engines: z.array(z.enum(["codex", "claude"])).min(1, "Pick at least one engine"),
  });
  const vibeOptions = [
    { id: "secure", key: "1", label: "Secure", desc: "mTLS only" },
    { id: "temporary", key: "2", label: "Temporary", desc: "2h expiry" },
    { id: "insecure-curl", key: "3", label: "Insecure curl", desc: "no mTLS" },
    { id: "vip", key: "4", label: "VIP", desc: "no scaling" },
  ] as const;
  const engineOptions = [
    { id: "codex", key: "5", label: "Codex", desc: "OpenAI Codex" },
    { id: "claude", key: "6", label: "Claude", desc: "Claude Code" },
  ] as const;

  let fqdn = $state("");
  let vibe = $state<("secure" | "temporary" | "insecure-curl" | "vip")[]>(["secure"]);
  let engines = $state<("codex" | "claude")[]>(["codex"]);
  let result = $state<HostRegisterResponse | null>(null);
  let errors = $state<Record<string, string>>({});
  let submitting = $state(false);

  function reset(): void {
    fqdn = "";
    vibe = ["secure"];
    engines = ["codex"];
    result = null;
    errors = {};
  }

  function handleOpenChange(value: boolean): void {
    if (!value) reset();
    open = value;
    onOpenChange?.(value);
  }

  function toggleVibe(v: "secure" | "temporary" | "insecure-curl" | "vip"): void {
    if (vibe.includes(v)) {
      vibe = vibe.filter((x) => x !== v);
    } else {
      // secure / insecure-curl are mutually exclusive
      const next = vibe.filter((x) => !(v === "secure" && x === "insecure-curl") && !(v === "insecure-curl" && x === "secure"));
      vibe = [...next, v];
    }
  }

  function toggleEngine(e: "codex" | "claude"): void {
    engines = engines.includes(e) ? engines.filter((x) => x !== e) : [...engines, e];
  }

  async function focusHostname(): Promise<void> {
    await tick();
    const input = document.getElementById("new-fqdn");
    if (!(input instanceof HTMLInputElement) || input.disabled) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function handleSheetKeydown(event: KeyboardEvent): void {
    if (!open || result || submitting || event.defaultPrevented || event.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;

    const actions: Record<string, () => void> = {
      "1": () => toggleVibe("secure"),
      "2": () => toggleVibe("temporary"),
      "3": () => toggleVibe("insecure-curl"),
      "4": () => toggleVibe("vip"),
      "5": () => toggleEngine("codex"),
      "6": () => toggleEngine("claude"),
    };

    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      action();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void submit();
    }
  }

  async function submit(): Promise<void> {
    errors = {};
    const parsed = schema.safeParse({ fqdn, vibe, engines });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors[issue.path.join(".") || "_"] = issue.message;
      }
      return;
    }
    submitting = true;
    try {
      const payload = {
        fqdn: parsed.data.fqdn,
        engines: parsed.data.engines,
        secure: !parsed.data.vibe.includes("insecure-curl"),
        temporary: parsed.data.vibe.includes("temporary"),
        curl_insecure: parsed.data.vibe.includes("insecure-curl"),
        vip: parsed.data.vibe.includes("vip"),
      };
      const data = await $register.mutateAsync(payload);
      result = data;
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      await autoCopyText(
        data.installer.command,
        `Registered ${data.host.fqdn ?? parsed.data.fqdn}; installer command copied`,
        `Registered ${data.host.fqdn ?? parsed.data.fqdn}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      toast.error(msg);
    } finally {
      submitting = false;
    }
  }

  async function deleteAccident(): Promise<void> {
    if (!result?.host?.id) return;
    try {
      await $deleteMut.mutateAsync({ id: result.host.id });
      toast.success("Host deleted");
      reset();
      handleOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error(msg);
    }
  }

  function mintAnother(): void {
    reset();
  }

  $effect(() => {
    if (open && !result) {
      void focusHostname();
    }
  });

  onMount(() => {
    window.addEventListener("keydown", handleSheetKeydown);
    return () => window.removeEventListener("keydown", handleSheetKeydown);
  });
</script>

<Sheet.Root bind:open onOpenChange={handleOpenChange}>
  <Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-md">
    <Sheet.Header>
      <Sheet.Title>{result ? "Host minted" : "New host"}</Sheet.Title>
      <Sheet.Description>
        {result
          ? "Run the installer on the target machine within the window below."
          : "Provision a fresh host. Pick a vibe and the engines this host should run."}
      </Sheet.Description>
    </Sheet.Header>

    {#if !result}
      <form
        class="mt-6 space-y-5"
        onsubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="space-y-1.5">
          <Label for="new-fqdn">Hostname (FQDN)</Label>
          <Input
            id="new-fqdn"
            placeholder="vm42.example.org"
            bind:value={fqdn}
            autocomplete="off"
            disabled={submitting}
          />
          {#if errors.fqdn}
            <p class="text-xs text-destructive">{errors.fqdn}</p>
          {/if}
        </div>

        <div class="space-y-2">
          <Label>Vibe</Label>
          <div class="grid grid-cols-2 gap-2">
            {#each vibeOptions as opt}
              {@const isOn = vibe.includes(opt.id)}
              <button
                type="button"
                class="flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left text-xs transition-colors {isOn ? 'border-primary bg-primary/5' : 'border-input hover:bg-accent'}"
                onclick={() => toggleVibe(opt.id)}
              >
                <span class="flex w-full items-center justify-between gap-2">
                  <span class="text-sm font-medium">{opt.label}</span>
                  <kbd class="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                    {opt.key}
                  </kbd>
                </span>
                <span class="text-[10px] text-muted-foreground">{opt.desc}</span>
              </button>
            {/each}
          </div>
        </div>

        <div class="space-y-2">
          <Label>Engines</Label>
          <div class="grid grid-cols-2 gap-2">
            {#each engineOptions as opt}
              <button
                type="button"
                class="flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left text-xs transition-colors {engines.includes(opt.id) ? 'border-primary bg-primary/5' : 'border-input hover:bg-accent'}"
                onclick={() => toggleEngine(opt.id)}
              >
                <span class="flex w-full items-center justify-between gap-2">
                  <span class="text-sm font-medium">{opt.label}</span>
                  <kbd class="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                    {opt.key}
                  </kbd>
                </span>
                <span class="text-[10px] text-muted-foreground">{opt.desc}</span>
              </button>
            {/each}
          </div>
          {#if errors.engines}
            <p class="text-xs text-destructive">{errors.engines}</p>
          {/if}
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onclick={() => handleOpenChange(false)} type="button">Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitting ? "Working…" : "Register host"}</Button>
        </div>
      </form>
    {:else}
      <div class="mt-6 space-y-4">
        <div class="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          <span class="font-mono">{result.host.fqdn ?? fqdn}</span> · token expires {new Date(result.installer.expires_at).toLocaleString()}
        </div>
        <div class="flex flex-wrap gap-1.5">
          {#if vibe.includes("secure")}
            <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Secure</span>
          {/if}
          {#if vibe.includes("temporary")}
            <span class="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">Temporary</span>
          {/if}
          {#if vibe.includes("insecure-curl")}
            <span class="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">Insecure</span>
          {/if}
          {#if vibe.includes("vip")}
            <span class="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">VIP</span>
          {/if}
        </div>
        <div class="space-y-1.5">
          <Label for="newhost-installer">Installer command</Label>
          <textarea
            id="newhost-installer"
            readonly
            class="h-40 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs"
            value={result.installer.command}
          ></textarea>
        </div>
        <div class="flex flex-wrap items-center gap-2 pt-2">
          <CopyButton
            value={result.installer.command}
            label="Copy"
            toastMessage="Installer command copied"
          />
          <Button variant="secondary" onclick={mintAnother}>Mint another</Button>
          <Button variant="ghost" onclick={() => handleOpenChange(false)}>Close</Button>
          <div class="ml-auto">
            <Button variant="destructive" onclick={deleteAccident}>
              <Trash2 class="h-4 w-4" /> Delete accident
            </Button>
          </div>
        </div>
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
