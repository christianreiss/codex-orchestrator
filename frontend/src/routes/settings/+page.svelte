<script lang="ts">
  import PageHeader from "$lib/components/layout/PageHeader.svelte";
  import SettingsTocNav from "$lib/components/settings/SettingsTocNav.svelte";
  import ApiStateSection from "$lib/components/settings/ApiStateSection.svelte";
  import OpenAIEngineSection from "$lib/components/settings/OpenAIEngineSection.svelte";
  import ClaudeEngineSection from "$lib/components/settings/ClaudeEngineSection.svelte";
  import ReverseDnsSection from "$lib/components/settings/ReverseDnsSection.svelte";
  import AutoUpdateSection from "$lib/components/settings/AutoUpdateSection.svelte";
  import CdxSilentSection from "$lib/components/settings/CdxSilentSection.svelte";
  import InsecureApprovalSection from "$lib/components/settings/InsecureApprovalSection.svelte";
  import QuotasSection from "$lib/components/settings/QuotasSection.svelte";
  import CodexVersionSection from "$lib/components/settings/CodexVersionSection.svelte";
  import ScalingSection from "$lib/components/settings/ScalingSection.svelte";
  import PrunePolicySection from "$lib/components/settings/PrunePolicySection.svelte";
  import LogRetentionSection from "$lib/components/settings/LogRetentionSection.svelte";

  const tocItems = [
    { id: "api-state", label: "API state" },
    { id: "openai-engine", label: "OpenAI engine" },
    { id: "claude-engine", label: "Claude engine" },
    { id: "reverse-dns", label: "Reverse DNS" },
    { id: "auto-update", label: "Auto-update" },
    { id: "cdx-silent", label: "Codex silent mode" },
    { id: "insecure-approval", label: "Insecure approval" },
    { id: "quotas", label: "Quotas" },
    { id: "codex-version", label: "Codex version" },
    { id: "scaling", label: "Scaling" },
    { id: "prune-policy", label: "Prune policy" },
    { id: "log-retention", label: "Log retention" },
  ];
</script>

<PageHeader title="Settings" subtitle="System configuration" />

<div class="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
  <SettingsTocNav items={tocItems} />

  <div class="space-y-6">
    <ApiStateSection />
    <OpenAIEngineSection />
    <ClaudeEngineSection />
    <ReverseDnsSection />
    <AutoUpdateSection />
    <CdxSilentSection />
    <InsecureApprovalSection />
    <QuotasSection />
    <CodexVersionSection />
    <ScalingSection />
    <PrunePolicySection />
    <LogRetentionSection />
  </div>
</div>
