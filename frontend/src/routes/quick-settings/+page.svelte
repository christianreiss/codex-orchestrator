<script lang="ts">
  import { base } from "$app/paths";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import { Button } from "$lib/components/ui/button";
  import QuickModelDefaults from "$lib/components/settings/QuickModelDefaults.svelte";
</script>

<PageHeader title="Quick Settings" subtitle="Choose the default model and effort for each engine. Changes save immediately.">
  {#snippet actions()}
    <Button variant="outline" href={`${base}/engines`}>All engine settings <ArrowUpRight class="h-4 w-4" /></Button>
  {/snippet}
</PageHeader>

<div class="grid items-start gap-5 xl:grid-cols-2">
  <QuickModelDefaults engine="codex" />
  <QuickModelDefaults engine="claude" />
</div>
<p class="mt-4 text-sm text-muted-foreground">Defaults apply when managed clients next sync. Host overrides take precedence.</p>
