<script lang="ts">
  /**
   * Fleet response-verbosity dial: one slider, 0 (today's behavior) to 4 (at
   * most 2 sentences). Global, not per-host — see agent-response-style.ts.
   */
  import { Label } from "$lib/components/ui/label";
  import { Slider } from "$lib/components/ui/slider";
  import * as Card from "$lib/components/ui/card";
  import type { ResponseVerbosityLevelOption } from "$lib/api/agents";

  type Props = {
    level: number;
    levels: ResponseVerbosityLevelOption[];
    disabled?: boolean;
    onChange: (level: number) => void;
  };

  let { level, levels, disabled = false, onChange }: Props = $props();

  const label = $derived(levels.find((l) => l.level === level)?.label ?? "Full (today)");
</script>

<Card.Root>
  <Card.Content class="space-y-3 p-4">
    <div class="space-y-1">
      <h3 class="text-sm font-semibold">Response verbosity</h3>
      <p class="text-xs text-muted-foreground">
        How much text agents send back. 0 is today's behavior; 4 caps every response at 2 sentences.
        Projected into the served CLAUDE.md/AGENTS.md policy text, and into Claude Code's own output
        style for clx hosts.
      </p>
    </div>
    <div class="space-y-1">
      <Label for="response-verbosity" class="sr-only">Response verbosity level</Label>
      <Slider
        id="response-verbosity"
        value={level}
        max={4}
        {disabled}
        aria-label="Response verbosity level"
        onValueChange={(value) => onChange(value)}
      />
      <p class="text-xs">
        <span class="font-mono text-muted-foreground">{level}</span>
        <span class="ml-1.5 text-foreground">{label}</span>
      </p>
    </div>
  </Card.Content>
</Card.Root>
