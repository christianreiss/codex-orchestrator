<script lang="ts">
  /** Access: is this host trusted, and is temporary access open. */
  import { useQueryClient } from "@tanstack/svelte-query";
  import { Section } from "$lib/components/page";
  import { Button } from "$lib/components/ui/button";
  import { createSecureToggleMutation, isInsecureWindowActive } from "$lib/api/hosts";
  import { createEnableInsecureMutation, createDisableInsecureMutation } from "$lib/api/insecure";
  import type { HostDetail } from "$lib/api/types";
  import InsecureCountdown from "../InsecureCountdown.svelte";
  import InsecureWindowPopover from "../InsecureWindowPopover.svelte";
  import ToggleRow from "../ToggleRow.svelte";
  import { run, runQuiet } from "./actions";

  type Props = { host: HostDetail; id: string };
  let { host, id }: Props = $props();

  const qc = useQueryClient();
  const secure = createSecureToggleMutation(qc);
  const enable = createEnableInsecureMutation(qc);
  const disable = createDisableInsecureMutation(qc);
  const windowOpen = $derived(isInsecureWindowActive(host));
</script>

<Section title="Access">
  <ToggleRow
    label="Trusted host"
    note="Secure: may fetch credentials at any time. An untrusted host can only do so while temporary access is open."
    checked={host.secure}
    onchange={(v) => runQuiet($secure.mutateAsync({ id, value: v }))}
  />
  {#if windowOpen || host.secure === false}
    <div class="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <div class="min-w-0">
        <span class="block text-body">Temporary access</span>
        <span class="block text-body-sm text-muted-foreground">{windowOpen ? "Open" : "Closed"} · insecure window</span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#if windowOpen}
          <InsecureCountdown until={host.insecure_enabled_until} />
          <InsecureWindowPopover
            label="Extend"
            variant="outline"
            heading="Extend temporary access"
            confirmLabel="Extend"
            onConfirm={(duration_minutes) => run("Access extended", $enable.mutateAsync({ id, duration_minutes }))}
          />
          <Button variant="ghost" onclick={() => run("Access closed", $disable.mutateAsync({ id }))}>Close now</Button>
        {:else}
          <InsecureWindowPopover
            label="Open temporary access"
            heading="Open temporary access"
            confirmLabel="Open"
            onConfirm={(duration_minutes) => run("Access opened", $enable.mutateAsync({ id, duration_minutes }))}
          />
        {/if}
      </div>
    </div>
  {/if}
</Section>
