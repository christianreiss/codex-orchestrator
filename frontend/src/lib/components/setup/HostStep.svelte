<script lang="ts">
  /**
   * Optional final step: register the first host and watch it install.
   *
   * Same form and progress view as the Hosts page sheet (`HostRegisterForm`,
   * `HostInstallProgress`), so the two cannot drift. The wizard footer is the
   * commit button: "Register host" while a hostname is typed, "Finish" once
   * the command is shown or when the operator leaves the field empty.
   */
  import HostRegisterForm from "$lib/components/hosts/HostRegisterForm.svelte";
  import HostInstallProgress from "$lib/components/hosts/HostInstallProgress.svelte";
  import type { HostRegisterResponse } from "$lib/api/types";

  type Engine = "codex" | "claude";
  type Props = {
    defaultEngines: Engine[];
    /** Enter in the hostname field runs the same path as the footer. */
    onSubmitRequested?: () => void;
  };

  let { defaultEngines, onSubmitRequested }: Props = $props();

  let form = $state<HostRegisterForm | null>(null);
  let result = $state<HostRegisterResponse | null>(null);

  /** Function, not `$derived`: derived state cannot be exported from a
  * component. The caller's own `$derived` still tracks what this reads. */
  export function isBusy(): boolean {
    return form?.isBusy() ?? false;
  }

  /** A hostname is typed and nothing is registered yet. */
  export function hasPendingInput(): boolean {
    return result === null && (form?.hasPendingInput() ?? false);
  }

  /** Registers the typed host. True once registered (or nothing to do). */
  export async function submit(): Promise<boolean> {
    if (result || !form) return true;
    const data = await form.submit();
    if (data) result = data;
    return data !== null;
  }
</script>

{#if result}
  <HostInstallProgress
    hostId={result.host.id}
    fqdn={result.host.fqdn ?? "the host"}
    installer={result.installer}
  />
{:else}
  <div class="space-y-4">
    <p class="text-sm text-muted-foreground">
      Optional. Registering a host creates its API key and a one-time install command.
      Everything configured so far applies to it automatically. Leave the hostname empty to
      finish without one.
    </p>
    <HostRegisterForm
      bind:this={form}
      idPrefix="setup-host"
      {defaultEngines}
      hideSubmit
      {onSubmitRequested}
    />
  </div>
{/if}
