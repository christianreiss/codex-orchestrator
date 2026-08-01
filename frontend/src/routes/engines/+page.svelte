<script lang="ts">
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import ModelDefaultsSection from "$lib/components/settings/ModelDefaultsSection.svelte";
  import CodexVersionSection from "$lib/components/settings/CodexVersionSection.svelte";
  import ClaudeVersionSection from "$lib/components/settings/ClaudeVersionSection.svelte";
  import CdxSilentSection from "$lib/components/settings/CdxSilentSection.svelte";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
  import ScalingSection from "$lib/components/settings/ScalingSection.svelte";
  import ClaudeFleetSettings from "$lib/components/settings/ClaudeFleetSettings.svelte";
</script>

<PageHeader title="Engines" subtitle="Codex and Claude defaults, versions, quota enforcement, and client configuration." />

<div class="settings-workspace">
  <section id="codex-defaults" class="setting-boundary"><div class="setting-boundary__head"><h2>Codex</h2><p>Model defaults, effort, and fleet version controls.</p></div><ModelDefaultsSection engine="codex" /><div class="settings-grid"><CodexVersionSection /><CdxSilentSection /></div></section>
  <section id="claude-defaults" class="setting-boundary"><div class="setting-boundary__head"><h2>Claude</h2><p>Claude Code model defaults and fleet version controls.</p></div><ModelDefaultsSection engine="claude" /><ClaudeVersionSection /></section>
  <section id="quota-enforcement" class="setting-boundary"><div class="setting-boundary__head"><h2>Quota and scaling</h2><p>Fleet-wide enforcement and capacity policy.</p></div><div class="settings-grid"><QuotasSection /><ScalingSection /></div></section>
  <section id="claude-client" class="setting-boundary"><div class="setting-boundary__head"><h2>Claude client</h2><p>Owned Claude Code settings are deep-merged; user-authored settings remain intact.</p></div><ClaudeFleetSettings /></section>
</div>
