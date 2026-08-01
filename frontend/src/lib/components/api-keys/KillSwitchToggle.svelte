<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import { Switch } from "$lib/components/ui/switch";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { cn } from "$lib/utils/cn";
  import { reactiveOptions } from "$lib/components/projects/reactive-options.svelte.js";
  import { keysApi, keyQueryKeys, engineLabel } from "$lib/api/keys";
  import type { AdminApiKillSwitchState, ApiKeyEngine } from "$lib/api/types";

  type Props = { engine: ApiKeyEngine };
  let { engine }: Props = $props();

  const qc = useQueryClient();

  // Lives in the tab row and is shared across engines via one mounted
  // instance, so `engine` changes under it — the query's key/fn must be
  // reactive rather than baked in once at creation.
  const stateQuery = createQuery<AdminApiKillSwitchState>(
    reactiveOptions(() => ({
      queryKey: keyQueryKeys.state(engine),
      queryFn: () => keysApi.getState(engine),
    })),
  );

  const toggleMutation = createMutation<
    AdminApiKillSwitchState,
    Error,
    boolean,
    { previous?: AdminApiKillSwitchState }
  >({
    mutationFn: (disabled: boolean) => keysApi.setState(engine, disabled),
    onMutate: async (disabled: boolean) => {
      await qc.cancelQueries({ queryKey: keyQueryKeys.state(engine) });
      const previous = qc.getQueryData<AdminApiKillSwitchState>(keyQueryKeys.state(engine));
      qc.setQueryData<AdminApiKillSwitchState>(keyQueryKeys.state(engine), { disabled });
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(keyQueryKeys.state(engine), ctx.previous);
      toast.error(`Failed to update ${engineLabel(engine)} API state`, {
        description: err.message,
      });
    },
    onSuccess: (data) => {
      toast.success(
        data.disabled ? `${engineLabel(engine)} API disabled` : `${engineLabel(engine)} API enabled`,
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keyQueryKeys.state(engine) });
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

<div class="flex items-center gap-2">
  {#if loading}
    <Skeleton class="h-5 w-9 rounded-full" />
  {:else}
    {#if disabled}
      <ShieldAlert class="h-4 w-4 shrink-0 text-warning" />
    {:else}
      <ShieldCheck class="h-4 w-4 shrink-0 text-success" />
    {/if}
    <span class={cn("text-xs", disabled ? "text-warning-muted-foreground" : "text-muted-foreground")}>
      {engineLabel(engine)} API {disabled ? "disabled" : "enabled"}
    </span>
    <Switch
      checked={!disabled}
      onCheckedChange={onCheckedChange}
      disabled={pending || loading}
      aria-label="Toggle {engineLabel(engine)} API"
    />
  {/if}
</div>
