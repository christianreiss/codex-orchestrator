<script lang="ts">
  import { StateBlock } from "$lib/components/page";
  import SectionCard from "$lib/components/engines/SettingGroup.svelte";
  import { communicatorApiQuery, type ApiLevelCounts } from "$lib/api/communicator-api";

  type Props = { headingLevel?: 2 | 3 };
  let { headingLevel = 3 }: Props = $props();

  const query = communicatorApiQuery();
  const levels = $derived($query.data ?? null);

  const rows = $derived(
    levels
      ? ([
          ["Hosts", levels.clients.hosts],
          ["Live communicators", levels.clients.communicators],
        ] as Array<[string, ApiLevelCounts]>)
      : [],
  );
</script>

<SectionCard
  id="communicator-api"
  title="Communicator API level"
  description="The protocol level between host agents and this server. A host agent below the minimum updates immediately; one between the minimum and the current level updates once no agents are online. The server never blocks a host for being behind."
  {headingLevel}
>
  {#if $query.isPending}
    <StateBlock state="loading" rows={2} />
  {:else if $query.isError}
    <p role="alert" class="text-body-sm text-destructive">Communicator API level could not be loaded: {$query.error.message}</p>
  {:else if levels}
    <dl class="grid grid-cols-1 gap-x-6 gap-y-1 text-body-sm sm:grid-cols-3">
      <div><dt class="text-caption text-muted-foreground">Current level</dt><dd class="font-mono">{levels.api_version}</dd></div>
      <div>
        <dt class="text-caption text-muted-foreground">Minimum level</dt>
        <dd class="font-mono">{levels.min_api}</dd>
      </div>
      <div>
        <dt class="text-caption text-muted-foreground">Minimum source</dt>
        <dd>
          {#if levels.override_min_api !== null && levels.override_min_api > levels.default_min_api}
            Operator override ({levels.override_min_api}){levels.override_updated_at ? `, set ${new Date(levels.override_updated_at).toLocaleString()}` : ""}
          {:else}
            Built-in default ({levels.default_min_api})
          {/if}
        </dd>
      </div>
    </dl>
    <div class="overflow-x-auto">
      <table class="w-full text-body-sm">
        <caption class="pb-1 text-left text-caption text-muted-foreground">
          Clients that stated their level in the last 6 hours (counted by this API process since it started; a restart refills them within one poll).
        </caption>
        <thead>
          <tr class="border-b text-left text-caption text-muted-foreground">
            <th scope="col" class="py-1 pr-4 font-medium">Clients</th>
            <th scope="col" class="py-1 pr-4 text-right font-medium">Seen</th>
            <th scope="col" class="py-1 pr-4 text-right font-medium">Below minimum</th>
            <th scope="col" class="py-1 pr-4 text-right font-medium">Below current</th>
            <th scope="col" class="py-1 pr-4 text-right font-medium">At current</th>
            <th scope="col" class="py-1 text-right font-medium">Level not reported</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as [label, counts] (label)}
            <tr class="border-b last:border-0">
              <th scope="row" class="py-1 pr-4 text-left font-normal">{label}</th>
              <td class="py-1 pr-4 text-right tabular-nums">{counts.observed}</td>
              <td class="py-1 pr-4 text-right tabular-nums">{counts.below_min}</td>
              <td class="py-1 pr-4 text-right tabular-nums">{counts.below_current}</td>
              <td class="py-1 pr-4 text-right tabular-nums">{counts.at_current}</td>
              <td class="py-1 text-right tabular-nums">{counts.unreported}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-caption text-muted-foreground">
      Below current includes below minimum. Hosts running builds that predate the API level report nothing and are listed separately. Raise the minimum with <code class="font-mono">POST /admin/communicator/api-version</code>.
    </p>
  {/if}
</SectionCard>
