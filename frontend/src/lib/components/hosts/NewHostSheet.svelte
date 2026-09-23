<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { onMount, tick } from "svelte";
  import { toast } from "svelte-sonner";
  import { createDeleteHostMutation } from "$lib/api/hosts";
  import { defaultEnginesOf, setupStatusQuery } from "$lib/api/setup";
  import { useQueryClient } from "@tanstack/svelte-query";
  import HostRegisterForm, {
    HOST_OPTIONS,
    type HostOption,
    type HostFormEngine,
  } from "./HostRegisterForm.svelte";
  import HostInstallProgress from "./HostInstallProgress.svelte";
  import type { HostRegisterResponse } from "$lib/api/types";

  type Props = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  let { open = $bindable(false), onOpenChange }: Props = $props();

  const qc = useQueryClient();
  const deleteMut = createDeleteHostMutation(qc);
  const setup = setupStatusQuery();

  let form = $state<HostRegisterForm | null>(null);
  let result = $state<HostRegisterResponse | null>(null);
  let resultOptions = $state<HostOption[]>([]);
  // Remount the form on reset so no field survives into the next host.
  let formKey = $state(0);

  const defaultEngines = $derived(defaultEnginesOf($setup.data));

  function reset(): void {
    result = null;
    resultOptions = [];
    formKey += 1;
  }

  function handleOpenChange(value: boolean): void {
    if (!value) reset();
    open = value;
    onOpenChange?.(value);
  }

  async function submit(): Promise<void> {
    if (!form) return;
    const options = form.selectedOptions();
    const data = await form.submit();
    if (data) {
      resultOptions = options;
      result = data;
    }
  }

  function handleSheetKeydown(event: KeyboardEvent): void {
    if (!open || result || !form || form.isBusy() || event.defaultPrevented || event.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;

    const actions: Record<string, () => void> = {
      "1": () => form?.toggleOption("trusted"),
      "2": () => form?.toggleOption("curl_insecure"),
      "3": () => form?.toggleOption("temporary"),
      "4": () => form?.toggleOption("vip"),
      "5": () => form?.toggleEngine("codex" satisfies HostFormEngine),
      "6": () => form?.toggleEngine("claude" satisfies HostFormEngine),
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

  async function deleteAccident(): Promise<void> {
    if (!result?.host?.id) return;
    try {
      await $deleteMut.mutateAsync({ id: result.host.id });
      toast.success("Host deleted");
      handleOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error(msg);
    }
  }

  $effect(() => {
    if (open && !result && form) {
      void tick().then(() => form?.focus());
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
      <Sheet.Title>{result ? "Host registered" : "New host"}</Sheet.Title>
      <Sheet.Description>
        {result
          ? "Run the installer on the target machine. Progress shows up here as it happens."
          : "Register a host, pick its options and the engines it should run."}
      </Sheet.Description>
    </Sheet.Header>

    {#if !result}
      <div class="mt-6">
        {#key formKey}
          <HostRegisterForm
            bind:this={form}
            idPrefix="new"
            {defaultEngines}
            showShortcuts
            hideSubmit
            onSubmitRequested={submit}
          />
        {/key}
        <div class="flex justify-end gap-2 pt-6">
          <Button variant="ghost" onclick={() => handleOpenChange(false)} type="button">Cancel</Button>
          <Button onclick={submit} disabled={form?.isBusy() ?? false}>
            {form?.isBusy() ? "Registering…" : "Register host"}
          </Button>
        </div>
      </div>
    {:else}
      <div class="mt-6 space-y-4">
        {#if resultOptions.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each HOST_OPTIONS.filter((opt) => resultOptions.includes(opt.id)) as opt (opt.id)}
              <Badge
                variant={opt.id === "trusted"
                  ? "success"
                  : opt.id === "curl_insecure"
                    ? "warning"
                    : opt.id === "temporary"
                      ? "info"
                      : "secondary"}
              >
                {opt.label}
              </Badge>
            {/each}
          </div>
        {/if}

        <HostInstallProgress
          hostId={result.host.id}
          fqdn={result.host.fqdn ?? "the host"}
          installer={result.installer}
        />

        <div class="flex flex-wrap items-center gap-2 pt-2">
          <Button variant="secondary" onclick={reset}>Register another</Button>
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
