<script lang="ts">
  import { toast } from "svelte-sonner";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import SectionCard from "./SectionCard.svelte";
  import { prunePolicyMutation } from "$lib/api/settings";

  // No GET endpoint exists for the prune policy. The textarea seeds
  // with the default shape so admins have a template to edit. After
  // save, the new value is stored server-side; the textarea is the
  // local source of truth between sessions.
  let policyJson = $state(`{\n  "inactivity_days": 30\n}`);
  let parseError = $state<string | null>(null);
  let lastSavedAt = $state<Date | null>(null);

  const mutation = prunePolicyMutation({
    onSuccess: (data) => {
      lastSavedAt = new Date();
      // Reflect the clamped value the server returned.
      if (data && typeof data.inactivity_window_days === "number") {
        policyJson = JSON.stringify({ inactivity_days: data.inactivity_window_days }, null, 2);
      }
      toast.success("Prune policy saved");
    },
    onError: (err) => toast.error(err.message),
  });

  function save() {
    parseError = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(policyJson);
    } catch (err) {
      parseError = err instanceof Error ? err.message : "Invalid JSON";
      toast.error("Invalid JSON: " + parseError);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      parseError = "Policy must be a JSON object";
      toast.error(parseError);
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const days = Number(obj.inactivity_days);
    if (!Number.isFinite(days) || days < 0 || days > 60) {
      parseError = "inactivity_days must be an integer between 0 and 60";
      toast.error(parseError);
      return;
    }
    $mutation.mutate({ inactivity_days: Math.round(days) });
  }

  const status = $derived.by(() => {
    if ($mutation.isPending) return "saving" as const;
    if ($mutation.isError) return "error" as const;
    if ($mutation.isSuccess) return "saved" as const;
    return "idle" as const;
  });
</script>

<SectionCard
  id="prune-policy"
  title="Prune policy"
  description="Inactivity window before stale hosts are pruned. Edited as JSON. Field: inactivity_days (0–60)."
  {status}
  savedAt={lastSavedAt}
  error={$mutation.error?.message ?? parseError}
>
  <div class="grid gap-1.5">
    <Label for="prune-policy-json">Policy (JSON)</Label>
    <Textarea
      id="prune-policy-json"
      class="min-h-[120px] font-mono text-xs"
      bind:value={policyJson}
      spellcheck={false}
      placeholder={`{\n  "inactivity_days": 30\n}`}
    />
    {#if parseError}
      <p class="text-xs text-destructive">{parseError}</p>
    {/if}
  </div>

  <div>
    <Button size="sm" onclick={save} disabled={$mutation.isPending}>Save prune policy</Button>
  </div>
</SectionCard>
