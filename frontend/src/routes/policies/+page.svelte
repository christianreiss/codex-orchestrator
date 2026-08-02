<script lang="ts">
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import AutoUpdateSection from "$lib/components/settings/AutoUpdateSection.svelte";
  import ReverseDnsSection from "$lib/components/settings/ReverseDnsSection.svelte";
  import InsecureApprovalSection from "$lib/components/settings/InsecureApprovalSection.svelte";
  import PrunePolicySection from "$lib/components/settings/PrunePolicySection.svelte";
  import LogRetentionSection from "$lib/components/settings/LogRetentionSection.svelte";
  import ApiKeysInChatSection from "$lib/components/settings/ApiKeysInChatSection.svelte";
</script>

<PageHeader title="Policies" subtitle="Set fleet-wide update, trust, lifecycle, and retention rules." />

<div class="settings-workspace">
  <section id="fleet-behavior" class="setting-boundary"><div class="setting-boundary__head"><h2>Fleet behavior</h2><p>Rules inherited by managed hosts unless a host has an explicit override.</p></div><div class="divide-y"><AutoUpdateSection bordered={false} /><ReverseDnsSection bordered={false} /></div></section>
  <section id="agent-behavior" class="setting-boundary"><div class="setting-boundary__head"><h2>Agent behavior</h2><p>Fleet instructions injected into managed Codex and Claude documents.</p></div><ApiKeysInChatSection bordered={false} /></section>
  <section id="insecure-approval" class="setting-boundary"><InsecureApprovalSection /></section>
  <section id="host-lifecycle" class="setting-boundary"><div class="setting-boundary__head"><h2>Host lifecycle</h2><p>Prune inactive or never-provisioned hosts predictably.</p></div><PrunePolicySection /></section>
  <section id="log-retention" class="setting-boundary"><LogRetentionSection /></section>
</div>
