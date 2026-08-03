<script lang="ts">
  /**
   * Optional final step: register the first host and hand over its installer
   * command.
   *
   * Same payload mapping as `NewHostSheet` — the vibe chips there map onto
   * `secure` / `temporary` / `curl_insecure` / `vip` exactly like this — but
   * pared down, because a first-run wizard is the wrong place to explain four
   * host security postures. The full set stays on the Hosts page.
   */
  import { untrack } from "svelte";
  import { z } from "zod";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import { Alert, AlertDescription, AlertTitle } from "$lib/components/ui/alert";
  import { CopyButton } from "$lib/components/ui/copy-button";
  import { createRegisterHostMutation } from "$lib/api/hosts";
  import { invalidateSetup } from "$lib/api/setup";
  import { autoCopyText } from "$lib/utils/clipboard";
  import { cn } from "$lib/utils/cn";
  import type { HostRegisterResponse } from "$lib/api/types";

  type Engine = "codex" | "claude";
  type Props = {
    defaultEngines: Engine[];
    /** From the polling setup status; drives the "waiting for sync" line. */
    syncedHosts: number;
    totalHosts: number;
  };

  let { defaultEngines, syncedHosts, totalHosts }: Props = $props();

  const qc = useQueryClient();
  const register = createRegisterHostMutation();

  const schema = z.object({
    fqdn: z.string().trim().min(1, "Hostname is required"),
    engines: z.array(z.enum(["codex", "claude"])).min(1, "Pick at least one engine"),
  });

  let fqdn = $state("");
  // Seeded from the engines step, then owned by the chips below — reacting to
  // the prop afterwards would undo the operator's edits.
  let engines = $state<Engine[]>(
    untrack(() => (defaultEngines.length > 0 ? [...defaultEngines] : ["codex"])),
  );
  let errors = $state<Record<string, string>>({});
  let result = $state<HostRegisterResponse | null>(null);
  let submitting = $state(false);

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return submitting;
  }

  function toggleEngine(engine: Engine): void {
    engines = engines.includes(engine)
      ? engines.filter((e) => e !== engine)
      : [...engines, engine];
  }

  export async function submit(): Promise<boolean> {
    errors = {};
    const parsed = schema.safeParse({ fqdn, engines });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors[issue.path.join(".") || "_"] = issue.message;
      return false;
    }

    submitting = true;
    try {
      const data = await $register.mutateAsync({
        fqdn: parsed.data.fqdn,
        engines: parsed.data.engines,
        secure: true,
      });
      result = data;
      void qc.invalidateQueries({ queryKey: ["hosts"] });
      invalidateSetup(qc);
      await autoCopyText(
        data.installer.command,
        `Registered ${parsed.data.fqdn}; installer command copied`,
        `Registered ${parsed.data.fqdn}`,
      );
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Registration failed");
      return false;
    } finally {
      submitting = false;
    }
  }
</script>

{#if result}
  <div class="space-y-4">
    <Alert>
      <AlertTitle>Run this on {result.host.fqdn}</AlertTitle>
      <AlertDescription>
        It installs the wrapper with this host's base URL and API key baked in. The token
        is one-time and expires.
      </AlertDescription>
    </Alert>

    <textarea
      readonly
      class="h-24 w-full resize-none rounded-md border border-input bg-muted/40 p-3 font-mono text-xs"
      value={result.installer.command}
    ></textarea>
    <div class="flex items-center gap-2">
      <CopyButton
        value={result.installer.command}
        label="Copy command"
        toastMessage="Installer command copied"
      />
      {#if result.installer.expires_at}
        <span class="text-[11px] text-muted-foreground">
          Expires {new Date(result.installer.expires_at).toLocaleString()}.
        </span>
      {/if}
    </div>

    <div class="rounded-lg border p-3 text-sm">
      {#if syncedHosts > 0}
        <span class="text-emerald-600 dark:text-emerald-400">✓</span>
        {syncedHosts} of {totalHosts} host{totalHosts === 1 ? "" : "s"} synced. You are done.
      {:else}
        <span class="animate-pulse">○</span>
        Waiting for the first sync — this updates on its own once the command runs.
      {/if}
    </div>
  </div>
{:else}
  <div class="space-y-4">
    <p class="text-sm text-muted-foreground">
      Optional. Registering a host mints its API key and a one-time installer command;
      everything configured so far applies to it automatically.
    </p>

    <div class="space-y-1.5">
      <Label for="setup-host-fqdn">Hostname</Label>
      <Input
        id="setup-host-fqdn"
        bind:value={fqdn}
        placeholder="worker-1.example.com"
        aria-invalid={errors.fqdn ? "true" : undefined}
      />
      {#if errors.fqdn}<p class="text-xs text-destructive">{errors.fqdn}</p>{/if}
    </div>

    <div class="space-y-1.5">
      <Label>Engines on this host</Label>
      <div class="flex gap-2">
        {#each [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }] as const as option (option.id)}
          {@const active = engines.includes(option.id)}
          <button
            type="button"
            onclick={() => toggleEngine(option.id)}
            aria-pressed={active}
            class={cn(
              "rounded-md border px-3 py-1.5 text-sm transition-colors",
              active ? "border-primary bg-primary/10" : "hover:bg-muted",
            )}
          >
            {option.label}
            {#if active}<Badge variant="secondary" class="ml-2">on</Badge>{/if}
          </button>
        {/each}
      </div>
      {#if errors.engines}<p class="text-xs text-destructive">{errors.engines}</p>{/if}
    </div>

    <Button onclick={submit} disabled={submitting}>
      {submitting ? "Registering…" : "Register host"}
    </Button>
  </div>
{/if}
