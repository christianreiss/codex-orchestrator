<script lang="ts">
  import ChattySettings from "$lib/components/chatty/ChattySettings.svelte";
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import ModelDefaultsSection from "$lib/components/settings/ModelDefaultsSection.svelte";
  import CodexVersionSection from "$lib/components/settings/CodexVersionSection.svelte";
  import GrokVersionSection from "$lib/components/settings/GrokVersionSection.svelte";
  import ClaudeVersionSection from "$lib/components/settings/ClaudeVersionSection.svelte";
  import CdxSilentSection from "$lib/components/settings/CdxSilentSection.svelte";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
  import ScalingSection from "$lib/components/settings/ScalingSection.svelte";
  import ClaudeFleetSettings from "$lib/components/settings/ClaudeFleetSettings.svelte";
  import EngineMasterSwitches from "$lib/components/settings/EngineMasterSwitches.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { useFleetEngines, FLEET_DISABLED_TAG } from "$lib/engines/fleet-engines";
  import { ENGINE_META, type Engine } from "$lib/constants/engines";
  import { base } from "$app/paths";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import { Button } from "$lib/components/ui/button";

  const fleet = useFleetEngines();
</script>

<!-- Off engines stay fully editable: the badge says why, the dim says it is
     not live, and nothing here sets pointer-events. -->
{#snippet offBanner(engine: Engine)}
  {#if !$fleet.isEnabled(engine)}
    <div class="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-muted px-3 py-2 text-xs text-warning-muted-foreground" role="status">
      <Badge variant="warning">{FLEET_DISABLED_TAG}</Badge>
      <span>{ENGINE_META[engine].label} is off for the whole fleet. These settings stay editable and apply when it is turned back on.</span>
    </div>
  {/if}
{/snippet}

<PageHeader title="Engines" subtitle="One fleet. Three engines. Set defaults, control updates, and tune each client.">
  {#snippet actions()}
    <Button variant="outline" href={`${base}/hosts`}>Host overrides <ArrowUpRight class="h-4 w-4" /></Button>
  {/snippet}
</PageHeader>

<nav class="mb-6 flex flex-wrap gap-2 rounded-lg border bg-card p-2" aria-label="Engine settings sections">
  {#each [
    { id: 'engine-state', label: 'Master switches', dot: '' },
    { id: 'codex-defaults', label: 'Codex', dot: 'bg-persona-codex' },
    { id: 'claude-defaults', label: 'Claude', dot: 'bg-persona-claude' },
    { id: 'grok-defaults', label: 'Grok', dot: 'bg-persona-grok' },
    { id: 'quota-enforcement', label: 'Quota and scaling', dot: '' },
    { id: 'claude-client', label: 'Claude client', dot: '' },
  ] as section (section.id)}
    <a href={`#${section.id}`} class="inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {#if section.dot}<span class="h-2 w-2 rounded-full {section.dot}" aria-hidden="true"></span>{/if}
      {section.label}
    </a>
  {/each}
</nav>

<div class="settings-workspace">
  <section id="engine-state" class="setting-boundary">
    <div class="setting-boundary__head">
      <h2>Fleet engine switches</h2>
      <p>Turn Codex, Claude, or Grok off everywhere at once. The admin console never depends on an engine.</p>
    </div>
    <EngineMasterSwitches headingLevel={3} />
  </section>

  <section id="codex-defaults" class="setting-boundary">
    <div class="setting-boundary__head">
      <h2 class="flex items-center gap-2"><span class="h-2 w-2 rounded-full bg-persona-codex" aria-hidden="true"></span>Codex</h2>
      <p>Model defaults, effort, and fleet version controls.</p>
      {@render offBanner("codex")}
    </div>
    <div class:opacity-70={!$fleet.isEnabled("codex")}>
      <ModelDefaultsSection engine="codex" headingLevel={3} />
      <CodexVersionSection headingLevel={3} />
      <CdxSilentSection bordered={false} />
    </div>
  </section>

  <section id="claude-defaults" class="setting-boundary">
    <div class="setting-boundary__head">
      <h2 class="flex items-center gap-2"><span class="h-2 w-2 rounded-full bg-persona-claude" aria-hidden="true"></span>Claude</h2>
      <p>Claude Code model defaults and fleet version controls.</p>
      {@render offBanner("claude")}
    </div>
    <div class:opacity-70={!$fleet.isEnabled("claude")}>
      <ModelDefaultsSection engine="claude" headingLevel={3} />
      <ClaudeVersionSection headingLevel={3} />
    </div>
  </section>

  <section id="grok-defaults" class="setting-boundary">
    <div class="setting-boundary__head">
      <h2 class="flex items-center gap-2"><span class="h-2 w-2 rounded-full bg-persona-grok" aria-hidden="true"></span>Grok</h2>
      <p>Grok Build subscription models, effort, and fleet version controls. Managed TOML settings are merged with user configuration.</p>
      {@render offBanner("grok")}
    </div>
    <div class:opacity-70={!$fleet.isEnabled("grok")}>
      <ModelDefaultsSection engine="grok" headingLevel={3} />
      <GrokVersionSection headingLevel={3} />
    </div>
  </section>

  <ChattySettings />

  <section id="quota-enforcement" class="setting-boundary">
    <div class="setting-boundary__head">
      <h2>Quota and scaling</h2>
      <p>Fleet-wide enforcement and capacity policy.</p>
    </div>
    <QuotasSection headingLevel={3} />
    <ScalingSection headingLevel={3} />
  </section>

  <section id="claude-client" class="setting-boundary">
    <div class="setting-boundary__head">
      <h2>Claude client</h2>
      <p>Owned Claude Code settings are deep-merged; user-authored settings remain intact.</p>
      {@render offBanner("claude")}
    </div>
    <div class:opacity-70={!$fleet.isEnabled("claude")}>
      <ClaudeFleetSettings />
    </div>
  </section>
</div>
