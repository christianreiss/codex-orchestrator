<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import type { Engine } from '$lib/constants/engines';
  import { modelPolicyQuery, modelPolicyMutation } from '$lib/api/model-policy';
  import { authStore } from '$lib/stores/auth';
  import { Switch } from '$lib/components/ui/switch';
  import { Label } from '$lib/components/ui/label';
  let { engine }: { engine: Engine } = $props();
  const stableEngine = untrack(() => engine);
  const query = modelPolicyQuery(stableEngine);
  const mutation = modelPolicyMutation(stableEngine);
  let pending = $state<boolean | null>(null);
  function change(value: boolean) {
    pending = value;
    $mutation.mutate(value, {
      onError: error => toast.error(error.message),
      onSettled: () => { pending = null; },
    });
  }
</script>
<div id={`${stableEngine}-model-policy`} class="scroll-mt-20 py-2">
  <div class="flex items-center justify-between gap-3">
    <div class="min-w-0">
      <Label for={`${stableEngine}-latest-models`} class="text-body font-medium">Only current models</Label>
      <p class="mt-0.5 text-body-sm text-muted-foreground">
        New managed starts and API requests upgrade older choices within the same family. Running sessions keep their model;
        hosts apply this after the next configuration sync.
      </p>
    </div>
    <Switch id={`${stableEngine}-latest-models`} aria-label="Only current models"
      checked={pending ?? $query.data?.latest_only ?? false}
      disabled={$query.isPending || $query.isError || $mutation.isPending || !$authStore.can('settings.manage')}
      onCheckedChange={change} />
  </div>
  {#if $query.data?.latest_only}
    <p class="mt-1 text-caption text-muted-foreground">Current models: {$query.data.latest_models.join(', ')}</p>
  {/if}
  {#if $query.error ?? $mutation.error}<p class="mt-1 text-caption text-destructive" role="alert">{($query.error ?? $mutation.error)?.message}</p>{/if}
</div>
