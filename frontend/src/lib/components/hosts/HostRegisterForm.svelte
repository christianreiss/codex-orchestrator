<script lang="ts" module>
  export type HostOption = "trusted" | "curl_insecure" | "temporary" | "vip";
  export type HostFormEngine = "codex" | "claude";

  /**
   * Each chip maps to exactly one register flag; none implies another.
   * `trusted` is `secure`: the host gets auth without an admin-opened
   * approval window. `curl_insecure` only relaxes TLS verification in the
   * installer and wrapper — it says nothing about trust.
   */
  export const HOST_OPTIONS: { id: HostOption; key: string; label: string; desc: string }[] = [
    { id: "trusted", key: "1", label: "Trusted", desc: "No approval window" },
    { id: "curl_insecure", key: "2", label: "Skip TLS verification", desc: "For self-signed certificates" },
    { id: "temporary", key: "3", label: "Temporary", desc: "Expires after 2 hours" },
    { id: "vip", key: "4", label: "VIP", desc: "Quota limits only warn" },
  ];

  export const HOST_ENGINE_OPTIONS: { id: HostFormEngine; key: string; label: string; desc: string }[] = [
    { id: "codex", key: "5", label: "Codex", desc: "OpenAI Codex CLI (cdx)" },
    { id: "claude", key: "6", label: "Claude", desc: "Claude Code (clx)" },
  ];
</script>

<script lang="ts">
  /**
   * Host registration form shared by the Hosts page sheet and the setup
   * wizard, so the two cannot drift. Owns the field state; the container owns
   * what happens after (`submit()` resolves with the response).
   *
   * Engines follow `defaultEngines` until the operator touches them — the
   * setup status that supplies it usually lands after the form mounts, and a
   * one-time seed would stick at the fallback.
   */
  import { z } from "zod";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { ChoiceCard } from "$lib/components/ui/choice-card";
  import { createRegisterHostMutation } from "$lib/api/hosts";
  import { invalidateSetup } from "$lib/api/setup";
  import { autoCopyText } from "$lib/utils/clipboard";
  import type { HostRegisterResponse } from "$lib/api/types";

  type Props = {
    defaultEngines: HostFormEngine[];
    /** Prefix for element ids; two forms can be mounted at once. */
    idPrefix?: string;
    /** Show the 1–6 keyboard hints (the sheet binds those keys). */
    showShortcuts?: boolean;
    /** Hide the submit row; the container calls `submit()` itself. */
    hideSubmit?: boolean;
    /** Enter in the hostname field while `hideSubmit`: run the container's commit. */
    onSubmitRequested?: () => void;
    onCancel?: () => void;
  };

  let {
    defaultEngines,
    idPrefix = "host",
    showShortcuts = false,
    hideSubmit = false,
    onSubmitRequested,
    onCancel,
  }: Props = $props();

  const qc = useQueryClient();
  const register = createRegisterHostMutation();

  const schema = z.object({
    fqdn: z.string().trim().min(1, "Hostname is required"),
    engines: z.array(z.enum(["codex", "claude"])).min(1, "Pick at least one engine"),
  });

  let fqdn = $state("");
  // Trusted by default: an operator registering a host by hand vouches for it.
  let options = $state<HostOption[]>(["trusted"]);
  let engines = $state<HostFormEngine[]>(["codex"]);
  let enginesTouched = $state(false);
  let errors = $state<Record<string, string>>({});
  let submitting = $state(false);

  $effect(() => {
    if (enginesTouched) return;
    engines = defaultEngines.length > 0 ? [...defaultEngines] : ["codex"];
  });

  export function isBusy(): boolean {
    return submitting;
  }

  /** A hostname was typed; submitting would register something. */
  export function hasPendingInput(): boolean {
    return fqdn.trim() !== "";
  }

  export function selectedOptions(): HostOption[] {
    return [...options];
  }

  export function toggleOption(id: HostOption): void {
    options = options.includes(id) ? options.filter((o) => o !== id) : [...options, id];
  }

  export function toggleEngine(id: HostFormEngine): void {
    enginesTouched = true;
    engines = engines.includes(id) ? engines.filter((e) => e !== id) : [...engines, id];
  }

  export function focus(): void {
    const input = document.getElementById(`${idPrefix}-fqdn`);
    if (!(input instanceof HTMLInputElement) || input.disabled) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Registers the host. Resolves null on validation or request failure. */
  export async function submit(): Promise<HostRegisterResponse | null> {
    errors = {};
    const parsed = schema.safeParse({ fqdn, engines });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors[issue.path.join(".") || "_"] = issue.message;
      return null;
    }
    submitting = true;
    try {
      const data = await $register.mutateAsync({
        fqdn: parsed.data.fqdn,
        engines: parsed.data.engines,
        secure: options.includes("trusted"),
        curl_insecure: options.includes("curl_insecure"),
        temporary: options.includes("temporary"),
        vip: options.includes("vip"),
      });
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      invalidateSetup(qc);
      const name = data.host.fqdn ?? parsed.data.fqdn;
      await autoCopyText(
        data.installer.command,
        `Registered ${name}; installer command copied`,
        `Registered ${name}`,
      );
      return data;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
      return null;
    } finally {
      submitting = false;
    }
  }
</script>

{#snippet kbd(key: string)}
  {#if showShortcuts}
    <kbd
      class="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-muted-foreground"
    >
      {key}
    </kbd>
  {/if}
{/snippet}

<form
  class="space-y-5"
  onsubmit={(event) => {
    event.preventDefault();
    if (!hideSubmit) void submit();
    else onSubmitRequested?.();
  }}
>
  <div class="space-y-1.5">
    <Label for="{idPrefix}-fqdn">Hostname (FQDN)</Label>
    <Input
      id="{idPrefix}-fqdn"
      placeholder="worker-1.example.com"
      bind:value={fqdn}
      autocomplete="off"
      disabled={submitting}
      aria-invalid={errors.fqdn ? "true" : undefined}
    />
    {#if errors.fqdn}<p class="text-xs text-destructive">{errors.fqdn}</p>{/if}
  </div>

  <div class="space-y-2">
    <Label id="{idPrefix}-options-label">Options</Label>
    <div role="group" aria-labelledby="{idPrefix}-options-label" class="grid grid-cols-2 gap-2">
      {#each HOST_OPTIONS as opt (opt.id)}
        <ChoiceCard
          mode="checkbox"
          size="sm"
          title={opt.label}
          description={opt.desc}
          checked={options.includes(opt.id)}
          onSelect={() => toggleOption(opt.id)}
        >
          {#snippet badge()}{@render kbd(opt.key)}{/snippet}
        </ChoiceCard>
      {/each}
    </div>
  </div>

  <div class="space-y-2">
    <Label id="{idPrefix}-engines-label">Engines</Label>
    <div role="group" aria-labelledby="{idPrefix}-engines-label" class="grid grid-cols-2 gap-2">
      {#each HOST_ENGINE_OPTIONS as opt (opt.id)}
        <ChoiceCard
          mode="checkbox"
          size="sm"
          title={opt.label}
          description={opt.desc}
          checked={engines.includes(opt.id)}
          onSelect={() => toggleEngine(opt.id)}
        >
          {#snippet badge()}{@render kbd(opt.key)}{/snippet}
        </ChoiceCard>
      {/each}
    </div>
    {#if errors.engines}<p class="text-xs text-destructive">{errors.engines}</p>{/if}
  </div>

  {#if !hideSubmit}
    <div class="flex justify-end gap-2 pt-2">
      {#if onCancel}
        <Button variant="ghost" type="button" onclick={onCancel}>Cancel</Button>
      {/if}
      <Button type="submit" disabled={submitting}>
        {submitting ? "Registering…" : "Register host"}
      </Button>
    </div>
  {/if}
</form>
