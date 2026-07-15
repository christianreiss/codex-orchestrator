<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import { Switch } from "$lib/components/ui/switch";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { cn } from "$lib/utils/cn";
  import { keysApi, keyQueryKeys, engineLabel } from "$lib/api/keys";
  import type { AdminApiKillSwitchState, ApiKeyEngine } from "$lib/api/types";

  type Props = { engine: ApiKeyEngine };
  let { engine }: Props = $props();
  // Engine is fixed per component instance (one card per engine); snapshot it
  // so the svelte-query option object doesn't capture a reactive proxy.
  // svelte-ignore state_referenced_locally
  const engineKey: ApiKeyEngine = engine;

  const qc = useQueryClient();

  const stateQuery = createQuery<AdminApiKillSwitchState>({
    queryKey: keyQueryKeys.state(engineKey),
    queryFn: () => keysApi.getState(engineKey),
  });

  const toggleMutation = createMutation<
    AdminApiKillSwitchState,
    Error,
    boolean,
    { previous?: AdminApiKillSwitchState }
  >({
    mutationFn: (disabled: boolean) => keysApi.setState(engineKey, disabled),
    onMutate: async (disabled: boolean) => {
      await qc.cancelQueries({ queryKey: keyQueryKeys.state(engineKey) });
      const previous = qc.getQueryData<AdminApiKillSwitchState>(keyQueryKeys.state(engineKey));
      qc.setQueryData<AdminApiKillSwitchState>(keyQueryKeys.state(engineKey), { disabled });
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(keyQueryKeys.state(engineKey), ctx.previous);
      toast.error(`Failed to update ${engineLabel(engineKey)} API state`, {
        description: err.message,
      });
    },
    onSuccess: (data) => {
      toast.success(
        data.disabled
          ? `${engineLabel(engineKey)} API disabled`
          : `${engineLabel(engineKey)} API enabled`,
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keyQueryKeys.state(engineKey) });
    },
  });

  const state = $derived($stateQuery.data);
  const disabled = $derived(state?.disabled ?? false);
  const loading = $derived($stateQuery.isLoading);
  const pending = $derived($toggleMutation.isPending);

  function onCheckedChange(next: boolean) {
    // Switch is "Enabled". When the user flips it off → disabled=true.
    const wantDisabled = !next;
    if (wantDisabled === disabled) return;
    $toggleMutation.mutate(wantDisabled);
  }
</script>

<div
  class={cn(
    "flex items-start justify-between gap-4 rounded-xl border p-4 shadow-sm",
    disabled
      ? "border-amber-500/60 bg-amber-50 dark:bg-amber-950/30"
      : "border-border bg-card",
  )}
>
  <div class="flex items-start gap-3">
    {#if disabled}
      <ShieldAlert class="mt-0.5 h-5 w-5 text-amber-500" />
    {:else}
      <ShieldCheck class="mt-0.5 h-5 w-5 text-emerald-600" />
    {/if}
    <div class="min-w-0">
      <p class="text-sm font-medium">
        {engineLabel(engine)} API is
        {#if loading}
          <span class="text-muted-foreground">loading…</span>
        {:else if disabled}
          <span class="text-amber-700 dark:text-amber-300">disabled</span>
        {:else}
          <span class="text-emerald-700 dark:text-emerald-400">enabled</span>
        {/if}
      </p>
      <p class="mt-1 text-xs text-muted-foreground">
        {#if disabled}
          All requests using {engineLabel(engine)} keys will be rejected.
        {:else}
          Active keys can make {engineLabel(engine)} requests.
        {/if}
      </p>
    </div>
  </div>

  <div class="flex items-center gap-2">
    {#if loading}
      <Skeleton class="h-6 w-11 rounded-full" />
    {:else}
      <span class="text-xs text-muted-foreground">Enabled</span>
      <Switch
        checked={!disabled}
        onCheckedChange={onCheckedChange}
        disabled={pending || loading}
        aria-label="Toggle {engineLabel(engine)} API"
      />
    {/if}
  </div>
</div>
