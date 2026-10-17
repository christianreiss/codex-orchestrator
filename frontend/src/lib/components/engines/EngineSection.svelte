<script lang="ts">
  /**
   * One engine on /engines: state and usage first, then the everyday settings
   * (default model, current-models policy, version), then a collapsed Advanced
   * block. Off engines stay editable; the notice says why they are not live.
   */
  import { base } from "$app/paths";
  import { Section } from "$lib/components/page";
  import { Badge } from "$lib/components/ui/badge";
  import { accountsQuery } from "$lib/api/accounts";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { useFleetEngines, FLEET_DISABLED_TAG } from "$lib/engines/fleet-engines";
  import { isNearQuota, needsAttention } from "$lib/components/accounts/account-state";
  import QuickModelDefaults from "$lib/components/settings/QuickModelDefaults.svelte";
  import ModelPolicySection from "$lib/components/settings/ModelPolicySection.svelte";
  import CodexVersionSection from "$lib/components/settings/CodexVersionSection.svelte";
  import ClaudeVersionSection from "$lib/components/settings/ClaudeVersionSection.svelte";
  import GrokVersionSection from "$lib/components/settings/GrokVersionSection.svelte";
  import CdxSilentSection from "$lib/components/settings/CdxSilentSection.svelte";
  import CodexCompactionSection from "$lib/components/settings/CodexCompactionSection.svelte";
  import NativeSettingsEditor from "$lib/components/settings/NativeSettingsEditor.svelte";
  import ClaudeFleetSettings from "$lib/components/settings/ClaudeFleetSettings.svelte";
  import EngineAdvanced from "./EngineAdvanced.svelte";

  type Props = { engine: Engine; advancedOpen?: boolean };
  let { engine, advancedOpen = $bindable(false) }: Props = $props();

  const meta = $derived(ENGINE_META[engine]);
  const fleet = useFleetEngines();
  const accounts = accountsQuery();
  const off = $derived(!$fleet.isEnabled(engine));
  const row = $derived($fleet.row(engine));
  const mine = $derived(($accounts.data?.accounts ?? []).filter((account) => account.engine === engine));
  const near = $derived(mine.filter(isNearQuota).length);
  const broken = $derived(mine.filter(needsAttention).length);
</script>

<Section id="{engine}-defaults" title={meta.label} description={`Fleet defaults for managed ${meta.command} clients. Per-host exceptions take precedence.`}>
  {#snippet actions()}
    <Badge variant={off ? "warning" : "success"}>{off ? FLEET_DISABLED_TAG : "On"}</Badge>
  {/snippet}

  <div class="divide-y">
    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-body-sm text-muted-foreground">
      {#if row}<span>{row.assigned_hosts} {row.assigned_hosts === 1 ? "host" : "hosts"}</span>{/if}
      <span>{mine.length} {mine.length === 1 ? "account" : "accounts"}</span>
      {#if near}<span class="text-warning-muted-foreground">{near} near quota</span>{/if}
      {#if broken}<span class="text-destructive">{broken} need attention</span>{/if}
      <a class="text-primary underline-offset-2 hover:underline" href={`${base}/accounts`}>Accounts</a>
      {#if off}
        <span class="basis-full text-warning-muted-foreground" role="status">Off for the whole fleet. These settings stay editable and apply when it is turned back on.</span>
      {/if}
    </p>

    <div class="space-y-2 py-3" class:opacity-70={off}>
      <QuickModelDefaults {engine} />
      <ModelPolicySection {engine} />
    </div>

    <div class="py-1" class:opacity-70={off}>
      {#if engine === "codex"}<CodexVersionSection headingLevel={3} />
      {:else if engine === "claude"}<ClaudeVersionSection headingLevel={3} />
      {:else}<GrokVersionSection headingLevel={3} />{/if}
    </div>

    <div class="pt-1" class:opacity-70={off}>
      <EngineAdvanced id="{engine}-advanced" bind:open={advancedOpen}>
        <NativeSettingsEditor {engine} />
        {#if engine === "codex"}
          <NativeSettingsEditor engine="codex" profiles />
          <div class="border-t pt-2"><CdxSilentSection bordered={false} /><CodexCompactionSection /></div>
        {:else if engine === "claude"}
          <div id="claude-client" class="scroll-mt-20 border-t pt-3">
            <h3 class="text-body font-medium">Claude client settings</h3>
            <p class="mb-2 mt-0.5 text-body-sm text-muted-foreground">Owned Claude Code settings are deep-merged; user-authored settings remain intact.</p>
            <ClaudeFleetSettings />
          </div>
        {/if}
        <p class="border-t pt-2 text-body-sm text-muted-foreground">
          Settings for a single machine live on the host.
          <a class="text-primary underline-offset-2 hover:underline" href={`${base}/hosts`}>Per-host exceptions</a>
        </p>
      </EngineAdvanced>
    </div>
  </div>
</Section>
