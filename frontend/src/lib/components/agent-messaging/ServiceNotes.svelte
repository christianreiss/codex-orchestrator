<script lang="ts">
  /**
   * What the Messages switch does and the fixed limits. The switch itself is in
   * the page header; this is the "settings" area behind the gear button.
   */
  import { Section } from "$lib/components/page";
  let { enabled }: { enabled: boolean } = $props();
</script>

<Section
  id="service-state"
  title="Service settings"
  description="Codex, Claude, Grok and Server communicate through stable addresses, opt-in groups and follows, encrypted content, and ordered at-least-once delivery. The initial default is off."
>
  <ul class="space-y-1 text-body-sm text-muted-foreground">
    <li>The service is currently <strong class="text-foreground">{enabled ? "on" : "off"}</strong>. Use the switch in the page header to change it; both directions ask for confirmation.</li>
    <li>Enabling adds an Agent Messaging section to every active host's AGENTS.md / CLAUDE.md, replacing the whole file on their next wrapper launch.</li>
    <li>Limits: 32 KiB text · 24h default TTL · 12 delivery attempts · opt-in group publications.</li>
    <li>Launch names that sound German are reserved for 24 hours after an agent exits; updated wrappers confirm their name before launch.</li>
  </ul>
</Section>
