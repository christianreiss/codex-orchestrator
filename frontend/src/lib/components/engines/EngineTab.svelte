<script lang="ts">
  /**
   * One engine's settings, split into sub-tabs. Off engines stay editable: the
   * banner says why, the dim says it is not live, nothing sets pointer-events.
   */
  import type { Snippet } from "svelte";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Badge } from "$lib/components/ui/badge";
  import { authStore } from "$lib/stores/auth";
  import ModelPolicySection from "$lib/components/settings/ModelPolicySection.svelte";
  import ModelDefaultsSection from "$lib/components/settings/ModelDefaultsSection.svelte";
  import NativeSettingsEditor from "$lib/components/settings/NativeSettingsEditor.svelte";
  import EngineDestroyPanel from "$lib/components/settings/EngineDestroyPanel.svelte";
  import { useFleetEngines, FLEET_DISABLED_TAG } from "$lib/engines/fleet-engines";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import type { EngineSubTab } from "$lib/engines/engine-tabs";

  type Props = {
    engine: Engine;
    sub: EngineSubTab | null;
    onSub: (sub: EngineSubTab) => void;
    /** Version controls and anything else under "Versions". */
    versions: Snippet;
    /** Claude only: the deep-merged client settings. */
    client?: Snippet;
    /** Codex only: extra native editors (profiles). */
    nativeExtra?: Snippet;
  };
  let { engine, sub, onSub, versions, client, nativeExtra }: Props = $props();

  const fleet = useFleetEngines();
  const canMutate = $derived($authStore.can("settings.manage"));
  const off = $derived(!$fleet.isEnabled(engine));
  const active = $derived.by<EngineSubTab>(() => {
    if (sub === "danger") return off && $fleet.known ? "danger" : "models";
    if (sub === "client") return client ? "client" : "models";
    return sub ?? "models";
  });
</script>

{#if off}
  <div class="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground" role="status">
    <Badge variant="warning">{FLEET_DISABLED_TAG}</Badge>
    <span>{ENGINE_META[engine].label} is off for the whole fleet. These settings stay editable and apply when it is turned back on.</span>
  </div>
{/if}

<Tabs.Root value={active} onValueChange={(v) => onSub(v as EngineSubTab)}>
  <Tabs.List aria-label="{ENGINE_META[engine].label} settings">
    <Tabs.Trigger value="models">Models</Tabs.Trigger>
    <Tabs.Trigger value="versions">Versions</Tabs.Trigger>
    <Tabs.Trigger value="native">Native config</Tabs.Trigger>
    {#if client}<Tabs.Trigger value="client">Client settings</Tabs.Trigger>{/if}
    {#if off && $fleet.known}<Tabs.Trigger value="danger" class="text-destructive">Danger zone</Tabs.Trigger>{/if}
  </Tabs.List>

  <div class:opacity-70={off}>
    <Tabs.Content value="models" class="mt-4 space-y-4">
      <ModelPolicySection {engine} />
      <ModelDefaultsSection {engine} headingLevel={3} />
    </Tabs.Content>
    <Tabs.Content value="versions" class="mt-4 space-y-4">{@render versions()}</Tabs.Content>
    <Tabs.Content value="native" class="mt-4 space-y-4">
      <NativeSettingsEditor {engine} />
      {@render nativeExtra?.()}
    </Tabs.Content>
    {#if client}<Tabs.Content value="client" class="mt-4">{@render client()}</Tabs.Content>{/if}
  </div>
  {#if off && $fleet.known}
    <Tabs.Content value="danger" class="mt-4"><EngineDestroyPanel {engine} suspended={true} {canMutate} /></Tabs.Content>
  {/if}
</Tabs.Root>
