<script lang="ts">
  /**
   * "Which engines will this fleet run?" — the question that has never existed
   * anywhere in the UI.
   *
   * It matters because `DEFAULT_HOST_ENGINES` defaults to `codex`, so the old
   * checklist derived its auth steps from that and Claude simply never
   * appeared, even though the server reports canonical auth for both engines.
   *
   * This is a wizard answer, not a server default: `DEFAULT_HOST_ENGINES` is
   * env-only and needs a restart. The answer picks which auth panels the next
   * step renders and pre-selects engines on the host step.
   */
  import { Badge } from "$lib/components/ui/badge";
  import { cn } from "$lib/utils/cn";

  type Engine = "codex" | "claude";
  type Choice = "none" | "codex" | "claude" | "both";

  let { engines = $bindable() }: { engines: Engine[] } = $props();

  const CHOICES: { id: Choice; label: string; detail: string; engines: Engine[] }[] = [
    {
      id: "codex",
      label: "Codex only",
      detail: "OpenAI Codex CLI. Hosts get the cdx alias.",
      engines: ["codex"],
    },
    {
      id: "claude",
      label: "Claude only",
      detail: "Anthropic Claude Code. Hosts get the clx alias.",
      engines: ["claude"],
    },
    {
      id: "both",
      label: "Both",
      detail: "One cxx binary, both aliases. Each host can still run either.",
      engines: ["codex", "claude"],
    },
    {
      id: "none",
      label: "Neither yet",
      detail: "Skip credentials for now. Everything else still gets configured.",
      engines: [],
    },
  ];

  const selected = $derived.by((): Choice => {
    const codex = engines.includes("codex");
    const claude = engines.includes("claude");
    if (codex && claude) return "both";
    if (codex) return "codex";
    if (claude) return "claude";
    return "none";
  });

  function choose(choice: (typeof CHOICES)[number]) {
    engines = [...choice.engines];
  }
</script>

<div class="space-y-3">
  {#each CHOICES as choice (choice.id)}
    {@const active = selected === choice.id}
    <button
      type="button"
      onclick={() => choose(choice)}
      aria-pressed={active}
      class={cn(
        "flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition-colors",
        active ? "border-primary bg-primary/5" : "hover:bg-muted/50",
      )}
    >
      <span>
        <span class="block text-sm font-medium">{choice.label}</span>
        <span class="block text-xs text-muted-foreground">{choice.detail}</span>
      </span>
      {#if active}<Badge variant="secondary">Selected</Badge>{/if}
    </button>
  {/each}

  <p class="text-xs text-muted-foreground">
    Nothing is locked in. Engines are chosen per host at registration, and credentials can
    be seeded at any time from Hosts.
  </p>
</div>
