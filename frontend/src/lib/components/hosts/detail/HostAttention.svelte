<script lang="ts">
  /** "Needs attention": what is wrong with this host, each with an inline Fix. Always the first block. */
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Info from "@lucide/svelte/icons/info";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { insecureApprovalsQuery, createDisableInsecureMutation } from "$lib/api/insecure";
  import { useFleetEngines } from "$lib/engines/fleet-engines";
  import type { HostDetailResponse } from "$lib/api/types";
  import { hostAttention, type AttentionItem } from "../hostAttention";
  import { run } from "./actions";

  type Props = { data: HostDetailResponse; id: string; onInstall: () => void };
  let { data, id, onInstall }: Props = $props();

  const fleet = useFleetEngines();
  const approvals = insecureApprovalsQuery();
  const disableAccess = createDisableInsecureMutation(useQueryClient());

  const waiting = $derived(
    ($approvals.data?.requests ?? []).some(
      (r) => r.host_id === data.host.id && r.status === "pending" && r.live !== false && (!r.expires_at || Date.parse(r.expires_at) > Date.now()),
    ),
  );
  const items = $derived(
    hostAttention(data.host, {
      pendingApproval: waiting,
      disabledEngines: $fleet.disabled,
      versions: { codex: data.overview?.versions.client_version, claude: data.overview?.versions.claude_version, grok: data.overview?.versions.grok_version },
    }),
  );

  // Several problems often share one remedy; say what it does once.
  const hintShownFor = $derived.by(() => {
    const seen = new Set<string>();
    return new Set(items.filter((item) => item.hint && !seen.has(item.hint) && seen.add(item.hint)).map((item) => item.id));
  });

  function fix(item: AttentionItem): void {
    if (item.fix === "install") onInstall();
    else if (item.fix === "review-access") window.dispatchEvent(new CustomEvent("codex:open-insecure-approvals"));
    else if (item.fix === "close-window") void run("Temporary access closed", $disableAccess.mutateAsync({ id }));
    else if (item.fix === "engines-page") void goto(`${base}/engines`);
  }
  const fixLabel: Record<NonNullable<AttentionItem["fix"]>, string> = {
    install: "Fix", "review-access": "Review", "close-window": "Close", "engines-page": "Open Engines",
  };
</script>

<Section title="Needs attention">
  {#if items.length === 0}
    <p class="flex items-center gap-2 text-body text-muted-foreground"><CircleCheck class="h-4 w-4 text-success" /> Nothing needs attention.</p>
  {:else}
    <ul class="divide-y rounded-md border" aria-label="Problems on this host">
      {#each items as item (item.id)}
        <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5" data-tone={item.tone}>
          {#if item.tone === "warning"}<TriangleAlert class="h-4 w-4 shrink-0 text-warning" />{:else}<Info class="h-4 w-4 shrink-0 text-info" />{/if}
          <div class="min-w-0 flex-1">
            <p class="text-body">{item.text}</p>
            {#if item.hint && hintShownFor.has(item.id)}<p class="text-body-sm text-muted-foreground">{item.hint}</p>{/if}
          </div>
          {#if item.fix}
            <Button size="sm" variant={item.tone === "warning" ? "default" : "outline"} aria-label={`${fixLabel[item.fix]}: ${item.text}`} title={item.hint} onclick={() => fix(item)}>
              {fixLabel[item.fix]}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Section>
