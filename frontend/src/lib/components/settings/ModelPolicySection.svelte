<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import type { Engine } from '$lib/constants/engines';
  import { modelPolicyQuery, modelPolicyMutation } from '$lib/api/model-policy';
  import { authStore } from '$lib/stores/auth';
  import SectionCard from './SectionCard.svelte';
  import SwitchRow from './SwitchRow.svelte';
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
<SectionCard id={`${stableEngine}-model-policy`} title="Current models" headingLevel={3}
  description="Keep the latest version of each model family across the fleet."
  error={$query.error?.message ?? $mutation.error?.message}>
  <SwitchRow id={`${stableEngine}-latest-models`} label="Only current models"
    description="New managed CLI starts and API requests automatically upgrade older choices within the same family. Running sessions keep their model. Hosts apply this after configuration sync."
    checked={pending ?? $query.data?.latest_only ?? false}
    disabled={$query.isPending || $query.isError || $mutation.isPending || !$authStore.can('settings.manage')}
    onCheckedChange={change} />
  {#if $query.data?.latest_only}
    <p class="mt-2 text-xs text-muted-foreground">Current models: {$query.data.latest_models.join(', ')}</p>
  {/if}
</SectionCard>
